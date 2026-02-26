use std::io;
use std::sync::Arc;

use finger_kernel_config::load_local_model_config;
use finger_kernel_core::{ChatEngine, EchoChatEngine, KernelConfig, KernelRuntime};
use finger_kernel_model::ResponsesChatEngine;
use finger_kernel_protocol::{EventMsg, Submission};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

#[tokio::main]
async fn main() -> io::Result<()> {
    let chat_engine: Arc<dyn ChatEngine> = match load_local_model_config() {
        Ok(model_config) => Arc::new(ResponsesChatEngine::new(model_config)),
        Err(err) => {
            let _ = tokio::io::stderr()
                .write_all(format!("fallback to echo chat engine: {err}\n").as_bytes())
                .await;
            Arc::new(EchoChatEngine)
        }
    };

    let mut runtime = KernelRuntime::spawn_with_engine(KernelConfig::default(), chat_engine);
    let submission_tx = runtime.submission_sender();

    let stdin_task = tokio::spawn(async move {
        let mut lines = BufReader::new(tokio::io::stdin()).lines();
        while let Some(line) = lines.next_line().await? {
            if line.trim().is_empty() {
                continue;
            }

            let submission = match serde_json::from_str::<Submission>(&line) {
                Ok(item) => item,
                Err(err) => {
                    let _ = tokio::io::stderr()
                        .write_all(format!("invalid submission json: {err}\n").as_bytes())
                        .await;
                    continue;
                }
            };

            if submission_tx.send(submission).await.is_err() {
                break;
            }
        }

        Ok::<(), io::Error>(())
    });

    let mut stdout = tokio::io::stdout();
    while let Some(event) = runtime.events_mut().recv().await {
        let line = serde_json::to_string(&event)
            .map_err(|err| io::Error::new(io::ErrorKind::InvalidData, err.to_string()))?;
        stdout.write_all(line.as_bytes()).await?;
        stdout.write_all(b"\n").await?;
        stdout.flush().await?;

        if matches!(event.msg, EventMsg::ShutdownComplete) {
            break;
        }
    }

    let stdin_join = stdin_task.await;
    if let Ok(result) = stdin_join {
        let _ = result;
    }

    runtime
        .join()
        .await
        .map_err(|err| io::Error::new(io::ErrorKind::Other, err.to_string()))?;

    Ok(())
}
