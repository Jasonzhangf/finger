use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use finger_kernel_protocol::{
    ErrorEvent, Event, EventMsg, InputItem, Op, SessionConfiguredEvent, Submission, TaskCompleteEvent,
    TaskStartedEvent, TurnAbortReason, TurnAbortedEvent,
};
use thiserror::Error;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

#[derive(Debug, Clone)]
pub struct KernelConfig {
    pub session_id: String,
    pub channel_capacity: usize,
    pub task_idle_timeout: Duration,
}

impl Default for KernelConfig {
    fn default() -> Self {
        Self {
            session_id: "finger-kernel".to_string(),
            channel_capacity: 128,
            task_idle_timeout: Duration::from_millis(200),
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TurnRunResult {
    pub last_agent_message: Option<String>,
}

#[async_trait]
pub trait ChatEngine: Send + Sync {
    async fn run_turn(&self, items: &[InputItem]) -> Result<TurnRunResult, String>;
}

pub struct EchoChatEngine;

#[async_trait]
impl ChatEngine for EchoChatEngine {
    async fn run_turn(&self, items: &[InputItem]) -> Result<TurnRunResult, String> {
        let last = items.iter().rev().find_map(|item| match item {
            InputItem::Text { text } => Some(text.clone()),
        });
        Ok(TurnRunResult {
            last_agent_message: last,
        })
    }
}

#[derive(Debug, Error)]
pub enum KernelError {
    #[error("failed to send submission: runtime channel closed")]
    SubmissionChannelClosed,
    #[error("kernel join failed: {0}")]
    Join(#[from] tokio::task::JoinError),
}

pub struct KernelRuntime {
    submission_tx: mpsc::Sender<Submission>,
    event_rx: mpsc::Receiver<Event>,
    loop_handle: JoinHandle<()>,
}

struct RunningTask {
    sub_id: String,
    input_tx: mpsc::Sender<Vec<InputItem>>,
    handle: JoinHandle<()>,
}

impl KernelRuntime {
    pub fn spawn(config: KernelConfig) -> Self {
        Self::spawn_with_engine(config, Arc::new(EchoChatEngine))
    }

    pub fn spawn_with_engine(config: KernelConfig, chat_engine: Arc<dyn ChatEngine>) -> Self {
        let (submission_tx, submission_rx) = mpsc::channel(config.channel_capacity);
        let (event_tx, event_rx) = mpsc::channel(config.channel_capacity);

        let loop_handle = tokio::spawn(submission_loop(config, submission_rx, event_tx, chat_engine));

        Self {
            submission_tx,
            event_rx,
            loop_handle,
        }
    }

    pub async fn submit(&self, submission: Submission) -> Result<(), KernelError> {
        self.submission_tx
            .send(submission)
            .await
            .map_err(|_| KernelError::SubmissionChannelClosed)
    }

    pub fn submission_sender(&self) -> mpsc::Sender<Submission> {
        self.submission_tx.clone()
    }

    pub fn events_mut(&mut self) -> &mut mpsc::Receiver<Event> {
        &mut self.event_rx
    }

    pub async fn join(self) -> Result<(), KernelError> {
        self.loop_handle.await?;
        Ok(())
    }
}

async fn submission_loop(
    config: KernelConfig,
    mut submission_rx: mpsc::Receiver<Submission>,
    event_tx: mpsc::Sender<Event>,
    chat_engine: Arc<dyn ChatEngine>,
) {
    let _ = send_event(
        &event_tx,
        Event {
            id: "session".to_string(),
            msg: EventMsg::SessionConfigured(SessionConfiguredEvent {
                session_id: config.session_id.clone(),
            }),
        },
    )
    .await;

    let mut running_task: Option<RunningTask> = None;

    while let Some(submission) = submission_rx.recv().await {
        if running_task.as_ref().is_some_and(|task| task.handle.is_finished()) {
            running_task = None;
        }

        match submission.op {
            Op::UserTurn { mut items } => {
                if let Some(task) = running_task.as_ref() {
                    match task.input_tx.send(items).await {
                        Ok(()) => continue,
                        Err(send_error) => {
                            items = send_error.0;
                        }
                    }
                }

                let task = spawn_task(
                    submission.id,
                    items,
                    config.task_idle_timeout,
                    event_tx.clone(),
                    Arc::clone(&chat_engine),
                );
                running_task = Some(task);
            }
            Op::Interrupt => {
                if let Some(task) = running_task.take() {
                    task.handle.abort();
                    let _ = send_event(
                        &event_tx,
                        Event {
                            id: task.sub_id,
                            msg: EventMsg::TurnAborted(TurnAbortedEvent {
                                reason: TurnAbortReason::UserInterrupt,
                            }),
                        },
                    )
                    .await;
                }
            }
            Op::Shutdown => {
                if let Some(task) = running_task.take() {
                    task.handle.abort();
                    let _ = send_event(
                        &event_tx,
                        Event {
                            id: task.sub_id,
                            msg: EventMsg::TurnAborted(TurnAbortedEvent {
                                reason: TurnAbortReason::Shutdown,
                            }),
                        },
                    )
                    .await;
                }

                let _ = send_event(
                    &event_tx,
                    Event {
                        id: submission.id,
                        msg: EventMsg::ShutdownComplete,
                    },
                )
                .await;
                break;
            }
            Op::ExecApproval { .. } | Op::PatchApproval { .. } => {
                let _ = send_event(
                    &event_tx,
                    Event {
                        id: submission.id,
                        msg: EventMsg::Error(ErrorEvent {
                            message: "approval flow is not implemented in M2 yet".to_string(),
                        }),
                    },
                )
                .await;
            }
        }
    }
}

fn spawn_task(
    sub_id: String,
    initial_items: Vec<InputItem>,
    task_idle_timeout: Duration,
    event_tx: mpsc::Sender<Event>,
    chat_engine: Arc<dyn ChatEngine>,
) -> RunningTask {
    let (input_tx, mut input_rx) = mpsc::channel::<Vec<InputItem>>(32);
    let task_sub_id = sub_id.clone();

    let handle = tokio::spawn(async move {
        let _ = send_event(
            &event_tx,
            Event {
                id: task_sub_id.clone(),
                msg: EventMsg::TaskStarted(TaskStartedEvent {
                    model_context_window: None,
                }),
            },
        )
        .await;

        let mut pending = initial_items;
        let mut last_agent_message: Option<String> = None;

        loop {
            if !pending.is_empty() {
                match chat_engine.run_turn(&pending).await {
                    Ok(turn_result) => {
                        if turn_result.last_agent_message.is_some() {
                            last_agent_message = turn_result.last_agent_message;
                        }
                    }
                    Err(err) => {
                        let _ = send_event(
                            &event_tx,
                            Event {
                                id: task_sub_id.clone(),
                                msg: EventMsg::Error(ErrorEvent {
                                    message: format!("run_turn failed: {err}"),
                                }),
                            },
                        )
                        .await;
                        break;
                    }
                }
                pending.clear();
            }

            match tokio::time::timeout(task_idle_timeout, input_rx.recv()).await {
                Ok(Some(items)) => {
                    pending = items;
                }
                Ok(None) | Err(_) => break,
            }
        }

        let _ = send_event(
            &event_tx,
            Event {
                id: task_sub_id,
                msg: EventMsg::TaskComplete(TaskCompleteEvent { last_agent_message }),
            },
        )
        .await;
    });

    RunningTask {
        sub_id,
        input_tx,
        handle,
    }
}

async fn send_event(event_tx: &mpsc::Sender<Event>, event: Event) -> Result<(), mpsc::error::SendError<Event>> {
    event_tx.send(event).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use finger_kernel_protocol::{EventMsg, InputItem, Op, Submission, TurnAbortReason};

    async fn recv_event(rx: &mut mpsc::Receiver<Event>) -> Event {
        tokio::time::timeout(Duration::from_secs(2), rx.recv())
            .await
            .expect("timed out waiting event")
            .expect("event channel closed unexpectedly")
    }

    #[tokio::test]
    async fn emits_session_configured_on_start() {
        let mut runtime = KernelRuntime::spawn(KernelConfig::default());
        let event = recv_event(runtime.events_mut()).await;
        assert!(matches!(event.msg, EventMsg::SessionConfigured(_)));

        runtime
            .submit(Submission {
                id: "shutdown".to_string(),
                op: Op::Shutdown,
            })
            .await
            .expect("submit shutdown");
        runtime.join().await.expect("join runtime");
    }

    #[tokio::test]
    async fn user_turn_emits_started_then_complete() {
        let mut runtime = KernelRuntime::spawn(KernelConfig::default());
        let _ = recv_event(runtime.events_mut()).await;

        runtime
            .submit(Submission {
                id: "sub-1".to_string(),
                op: Op::UserTurn {
                    items: vec![InputItem::Text {
                        text: "hello".to_string(),
                    }],
                },
            })
            .await
            .expect("submit turn");

        let started = recv_event(runtime.events_mut()).await;
        assert!(matches!(started.msg, EventMsg::TaskStarted(_)));

        let completed = recv_event(runtime.events_mut()).await;
        assert!(matches!(
            completed.msg,
            EventMsg::TaskComplete(TaskCompleteEvent {
                last_agent_message: Some(ref message)
            }) if message == "hello"
        ));

        runtime
            .submit(Submission {
                id: "shutdown".to_string(),
                op: Op::Shutdown,
            })
            .await
            .expect("submit shutdown");
        runtime.join().await.expect("join runtime");
    }

    #[tokio::test]
    async fn interrupt_aborts_running_task() {
        let mut runtime = KernelRuntime::spawn(KernelConfig {
            task_idle_timeout: Duration::from_secs(5),
            ..KernelConfig::default()
        });
        let _ = recv_event(runtime.events_mut()).await;

        runtime
            .submit(Submission {
                id: "sub-1".to_string(),
                op: Op::UserTurn {
                    items: vec![InputItem::Text {
                        text: "long-running".to_string(),
                    }],
                },
            })
            .await
            .expect("submit turn");
        let _ = recv_event(runtime.events_mut()).await;

        runtime
            .submit(Submission {
                id: "interrupt".to_string(),
                op: Op::Interrupt,
            })
            .await
            .expect("submit interrupt");

        let aborted = recv_event(runtime.events_mut()).await;
        assert!(matches!(
            aborted.msg,
            EventMsg::TurnAborted(TurnAbortedEvent {
                reason: TurnAbortReason::UserInterrupt
            })
        ));

        runtime
            .submit(Submission {
                id: "shutdown".to_string(),
                op: Op::Shutdown,
            })
            .await
            .expect("submit shutdown");
        runtime.join().await.expect("join runtime");
    }

    #[tokio::test]
    async fn second_user_turn_is_injected_into_running_task() {
        let mut runtime = KernelRuntime::spawn(KernelConfig {
            task_idle_timeout: Duration::from_millis(250),
            ..KernelConfig::default()
        });
        let _ = recv_event(runtime.events_mut()).await;

        runtime
            .submit(Submission {
                id: "sub-1".to_string(),
                op: Op::UserTurn {
                    items: vec![InputItem::Text {
                        text: "first".to_string(),
                    }],
                },
            })
            .await
            .expect("submit first turn");
        let started = recv_event(runtime.events_mut()).await;
        assert!(matches!(started.msg, EventMsg::TaskStarted(_)));

        runtime
            .submit(Submission {
                id: "sub-2".to_string(),
                op: Op::UserTurn {
                    items: vec![InputItem::Text {
                        text: "second".to_string(),
                    }],
                },
            })
            .await
            .expect("submit second turn");

        let completed = recv_event(runtime.events_mut()).await;
        assert!(matches!(
            completed.msg,
            EventMsg::TaskComplete(TaskCompleteEvent {
                last_agent_message: Some(ref message)
            }) if message == "second"
        ));

        runtime
            .submit(Submission {
                id: "shutdown".to_string(),
                op: Op::Shutdown,
            })
            .await
            .expect("submit shutdown");
        runtime.join().await.expect("join runtime");
    }
}
