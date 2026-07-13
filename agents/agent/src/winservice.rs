//! Windows Service host (Phase 6). Compiled only on Windows with
//! `--features winservice`. This CANNOT be built or tested from the Linux
//! cerebro — the Windows Claude must validate it natively (see
//! README-windows-agent.md §6). The logic below follows the documented
//! `windows-service` 0.7 dispatcher pattern; treat it as unverified until it
//! starts cleanly under `sc.exe`.
//!
//! Everything else in the agent (WS, handshake, reconnect, ops) is already
//! verified on Linux; only the SCM plumbing here is pending native validation.

use std::ffi::OsString;
use std::sync::mpsc;
use std::time::Duration;

use anyhow::Result;
use tracing::{error, info};
use windows_service::service::{
    ServiceControl, ServiceControlAccept, ServiceExitCode, ServiceState, ServiceStatus,
    ServiceType,
};
use windows_service::service_control_handler::{self, ServiceControlHandlerResult};
use windows_service::{define_windows_service, service_dispatcher};

use crate::{run_agent_loop, Config};

const SERVICE_NAME: &str = "JarvisAgent";
const SERVICE_TYPE: ServiceType = ServiceType::OWN_PROCESS;

define_windows_service!(ffi_service_main, service_main);

/// Entry point invoked from `main()` when launched with `--service`. Blocks
/// until the SCM stops the service.
pub fn run() -> Result<()> {
    service_dispatcher::start(SERVICE_NAME, ffi_service_main)
        .map_err(|e| anyhow::anyhow!("service_dispatcher start failed: {e}"))
}

fn service_main(_args: Vec<OsString>) {
    if let Err(e) = run_service() {
        error!("service failed: {e}");
    }
}

fn run_service() -> Result<()> {
    // Channel the stop control handler uses to signal the async loop.
    let (stop_tx, stop_rx) = mpsc::channel::<()>();

    let handler = move |control| match control {
        ServiceControl::Stop | ServiceControl::Preshutdown => {
            let _ = stop_tx.send(());
            ServiceControlHandlerResult::NoError
        }
        ServiceControl::Interrogate => ServiceControlHandlerResult::NoError,
        _ => ServiceControlHandlerResult::NotImplemented,
    };
    let status_handle = service_control_handler::register(SERVICE_NAME, handler)?;

    let set_state = |state: ServiceState, controls: ServiceControlAccept| {
        status_handle.set_service_status(&ServiceStatus {
            service_type: SERVICE_TYPE,
            current_state: state,
            controls_accepted: controls,
            exit_code: ServiceExitCode::Win32(0),
            checkpoint: 0,
            wait_hint: Duration::default(),
            process_id: None,
        })
    };

    set_state(ServiceState::Running, ServiceControlAccept::STOP)?;
    info!("JarvisAgent service running");

    let cfg = Config::load()?;
    let rt = tokio::runtime::Runtime::new()?;
    rt.block_on(async move {
        // Bridge the blocking stop channel into an async future.
        let shutdown = async move {
            let _ = tokio::task::spawn_blocking(move || stop_rx.recv()).await;
        };
        let _ = run_agent_loop(cfg, shutdown).await;
    });

    set_state(ServiceState::Stopped, ServiceControlAccept::empty())?;
    info!("JarvisAgent service stopped");
    Ok(())
}
