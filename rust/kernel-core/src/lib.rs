use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use finger_kernel_protocol::{
    ErrorEvent, Event, EventMsg, InputItem, Op, SessionConfiguredEvent, Submission,
    TaskCompleteEvent, TaskStartedEvent, TurnAbortReason, TurnAbortedEvent, UserTurnOptions,
};
use thiserror::Error;
use tokio::sync::mpsc::{self, UnboundedSender};
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
    pub metadata_json: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct TurnRequest {
    pub items: Vec<InputItem>,
    pub options: UserTurnOptions,
}

#[async_trait]
pub trait ChatEngine: Send + Sync {
    async fn run_turn(
        &self,
        request: &TurnRequest,
        progress_tx: Option<UnboundedSender<EventMsg>>,
    ) -> Result<TurnRunResult, String>;
}

pub struct EchoChatEngine;

#[async_trait]
impl ChatEngine for EchoChatEngine {
    async fn run_turn(
        &self,
        request: &TurnRequest,
        _progress_tx: Option<UnboundedSender<EventMsg>>,
    ) -> Result<TurnRunResult, String> {
        let last = request.items.iter().rev().find_map(|item| match item {
            InputItem::Text { text } => Some(text.clone()),
            InputItem::Image { .. } | InputItem::LocalImage { .. } => None,
        });
        Ok(TurnRunResult {
            last_agent_message: last,
            metadata_json: None,
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
    input_tx: mpsc::Sender<TurnRequest>,
    handle: JoinHandle<()>,
}

impl KernelRuntime {
    pub fn spawn(config: KernelConfig) -> Self {
        Self::spawn_with_engine(config, Arc::new(EchoChatEngine))
    }

    pub fn spawn_with_engine(config: KernelConfig, chat_engine: Arc<dyn ChatEngine>) -> Self {
        let (submission_tx, submission_rx) = mpsc::channel(config.channel_capacity);
        let (event_tx, event_rx) = mpsc::channel(config.channel_capacity);

        let loop_handle = tokio::spawn(submission_loop(
            config,
            submission_rx,
            event_tx,
            chat_engine,
        ));

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
        if running_task
            .as_ref()
            .is_some_and(|task| task.handle.is_finished())
        {
            running_task = None;
        }

        match submission.op {
            Op::UserTurn { items, options } => {
                let mut request = TurnRequest { items, options };
                if let Some(task) = running_task.as_ref() {
                    match task.input_tx.send(request).await {
                        Ok(()) => continue,
                        Err(send_error) => {
                            request = send_error.0;
                        }
                    }
                }

                let task = spawn_task(
                    submission.id,
                    request,
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
    initial_request: TurnRequest,
    task_idle_timeout: Duration,
    event_tx: mpsc::Sender<Event>,
    chat_engine: Arc<dyn ChatEngine>,
) -> RunningTask {
    let (input_tx, mut input_rx) = mpsc::channel::<TurnRequest>(32);
    let task_sub_id = sub_id.clone();

    let handle = tokio::spawn(async move {
        let _ = send_event(
            &event_tx,
            Event {
                id: task_sub_id.clone(),
                msg: EventMsg::TaskStarted(TaskStartedEvent {
                    model_context_window: initial_request
                        .options
                        .context_window
                        .as_ref()
                        .and_then(|cfg| cfg.max_input_tokens),
                }),
            },
        )
        .await;

        let mut pending = initial_request;
        let mut last_agent_message: Option<String> = None;
        let mut last_metadata_json: Option<String> = None;

        loop {
            if !pending.items.is_empty() {
                let (progress_tx, mut progress_rx) = mpsc::unbounded_channel::<EventMsg>();
                let progress_event_tx = event_tx.clone();
                let progress_event_id = task_sub_id.clone();
                let forwarder = tokio::spawn(async move {
                    while let Some(progress_msg) = progress_rx.recv().await {
                        let _ = send_event(
                            &progress_event_tx,
                            Event {
                                id: progress_event_id.clone(),
                                msg: progress_msg,
                            },
                        )
                        .await;
                    }
                });

                let turn_result = chat_engine.run_turn(&pending, Some(progress_tx)).await;
                if let Err(error) = forwarder.await {
                    let message = format!("progress forwarder failed: {error}");
                    eprintln!("{message}");
                    let _ = send_event(
                        &event_tx,
                        Event {
                            id: task_sub_id.clone(),
                            msg: EventMsg::Error(ErrorEvent { message }),
                        },
                    )
                    .await;
                }
                match turn_result {
                    Ok(turn_result) => {
                        if turn_result.last_agent_message.is_some() {
                            last_agent_message = turn_result.last_agent_message;
                        }
                        if turn_result.metadata_json.is_some() {
                            last_metadata_json = turn_result.metadata_json;
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
                pending.items.clear();
            }

            match tokio::time::timeout(task_idle_timeout, input_rx.recv()).await {
                Ok(Some(request)) => {
                    pending = request;
                }
                Ok(None) | Err(_) => break,
            }
        }

        let _ = send_event(
            &event_tx,
            Event {
                id: task_sub_id,
                msg: EventMsg::TaskComplete(TaskCompleteEvent {
                    last_agent_message,
                    metadata_json: last_metadata_json,
                }),
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

async fn send_event(
    event_tx: &mpsc::Sender<Event>,
    event: Event,
) -> Result<(), mpsc::error::SendError<Event>> {
    event_tx.send(event).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use finger_kernel_protocol::{
        EventMsg, InputItem, ModelRoundEvent, Op, Submission, ToolCallEvent, ToolResultEvent,
        TurnAbortReason, UserTurnOptions,
    };

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
                    options: UserTurnOptions::default(),
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
                last_agent_message: Some(ref message),
                ..
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
                    options: UserTurnOptions::default(),
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
                    options: UserTurnOptions::default(),
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
                    options: UserTurnOptions::default(),
                },
            })
            .await
            .expect("submit second turn");

        let completed = recv_event(runtime.events_mut()).await;
        assert!(matches!(
            completed.msg,
            EventMsg::TaskComplete(TaskCompleteEvent {
                last_agent_message: Some(ref message),
                ..
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

    struct ProgressTestEngine;

    #[async_trait]
    impl ChatEngine for ProgressTestEngine {
        async fn run_turn(
            &self,
            _request: &TurnRequest,
            progress_tx: Option<UnboundedSender<EventMsg>>,
        ) -> Result<TurnRunResult, String> {
            if let Some(tx) = progress_tx {
                let _ = tx.send(EventMsg::ModelRound(ModelRoundEvent {
                    seq: 1,
                    round: 1,
                    function_calls_count: 1,
                    reasoning_count: 0,
                    history_items_count: 2,
                    has_output_text: false,
                    finish_reason: Some("tool_calls".to_string()),
                    response_status: Some("completed".to_string()),
                    response_incomplete_reason: None,
                    response_id: Some("resp_1".to_string()),
                    input_tokens: Some(20),
                    output_tokens: Some(10),
                    total_tokens: Some(30),
                    estimated_tokens_in_context_window: Some(30),
                    estimated_tokens_compactable: Some(26),
                    context_usage_percent: Some(10),
                    max_input_tokens: Some(300),
                    threshold_percent: Some(85),
                }));
                let _ = tx.send(EventMsg::ToolCall(ToolCallEvent {
                    seq: 2,
                    call_id: "call_1".to_string(),
                    tool_name: "shell.exec".to_string(),
                    input: serde_json::json!({"command":"pwd"}),
                }));
                let _ = tx.send(EventMsg::ToolResult(ToolResultEvent {
                    seq: 3,
                    call_id: "call_1".to_string(),
                    tool_name: "shell.exec".to_string(),
                    output: serde_json::json!({"ok": true}),
                    duration_ms: 12,
                }));
            }
            Ok(TurnRunResult {
                last_agent_message: Some("done".to_string()),
                metadata_json: None,
            })
        }
    }

    #[tokio::test]
    async fn forwards_progress_events_before_task_complete() {
        let mut runtime =
            KernelRuntime::spawn_with_engine(KernelConfig::default(), Arc::new(ProgressTestEngine));
        let _ = recv_event(runtime.events_mut()).await;

        runtime
            .submit(Submission {
                id: "sub-progress".to_string(),
                op: Op::UserTurn {
                    items: vec![InputItem::Text {
                        text: "hello".to_string(),
                    }],
                    options: UserTurnOptions::default(),
                },
            })
            .await
            .expect("submit turn");

        let started = recv_event(runtime.events_mut()).await;
        assert!(matches!(started.msg, EventMsg::TaskStarted(_)));

        let round_event = recv_event(runtime.events_mut()).await;
        assert!(matches!(
            round_event.msg,
            EventMsg::ModelRound(ModelRoundEvent { seq: 1, .. })
        ));

        let tool_call = recv_event(runtime.events_mut()).await;
        assert!(matches!(
            tool_call.msg,
            EventMsg::ToolCall(ToolCallEvent { seq: 2, .. })
        ));

        let tool_result = recv_event(runtime.events_mut()).await;
        assert!(matches!(
            tool_result.msg,
            EventMsg::ToolResult(ToolResultEvent { seq: 3, .. })
        ));

        let completed = recv_event(runtime.events_mut()).await;
        assert!(matches!(completed.msg, EventMsg::TaskComplete(_)));

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
