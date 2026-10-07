//! Keep render workers in the server's lifetime even after TerminateProcess.
//! https://learn.microsoft.com/windows/win32/procthread/job-objects
use anyhow::{Context, Result};
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use windows_sys::Win32::System::{
    JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    },
    Threading::GetCurrentProcess,
};

pub fn contain_workers() -> Result<()> {
    // SAFETY: All structures have the documented size and live through the
    // calls. The unnamed handle is not inheritable; only this process owns it.
    unsafe {
        let raw = CreateJobObjectW(std::ptr::null(), std::ptr::null());
        if raw.is_null() {
            return Err(std::io::Error::last_os_error()).context("cannot create worker job");
        }
        let job = OwnedHandle::from_raw_handle(raw);
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if SetInformationJobObject(
            job.as_raw_handle(),
            JobObjectExtendedLimitInformation,
            (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
            std::mem::size_of_val(&limits) as u32,
        ) == 0
            || AssignProcessToJobObject(job.as_raw_handle(), GetCurrentProcess()) == 0
        {
            return Err(std::io::Error::last_os_error()).context("cannot contain worker processes");
        }
        // Keep the job until OS process teardown (also on forced termination).
        // Dropping it earlier would terminate the server itself as well.
        std::mem::forget(job);
    }
    Ok(())
}
