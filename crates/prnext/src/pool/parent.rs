//! Kill a Linux worker if its native parent dies, even when JS cannot read EOF.
//! Normal shutdown still drains requests/work through the existing pipe protocol.
pub(super) fn configure(command: &mut tokio::process::Command) {
    #[cfg(target_os = "linux")]
    {
        let parent = std::process::id() as libc::pid_t;
        // SAFETY: Only async-signal-safe syscalls run after fork. Configure the
        // signal before checking getppid to close the parent-exited-before-prctl
        // race. Pool processes are spawned by the long-lived Tokio runtime
        // threads, never an idle-retiring blocking task.
        unsafe {
            command.pre_exec(move || {
                if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL, 0, 0, 0) != 0 {
                    return Err(std::io::Error::last_os_error());
                }
                if libc::getppid() != parent {
                    libc::_exit(1);
                }
                Ok(())
            });
        }
    }
    #[cfg(not(target_os = "linux"))]
    let _ = command;
}
