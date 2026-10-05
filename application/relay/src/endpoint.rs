//! The runner's endpoint for its terminals: a Unix socket in a private directory, or a
//! named pipe on Windows. Both are read and written at once, as answers come back while
//! the agent still writes; Windows serialises blocking reads and writes on one pipe
//! handle, so the pipe is opened for overlapped I/O, which tokio does.

use std::io;

use tokio::io::{AsyncRead, AsyncWrite};

pub type Reader = Box<dyn AsyncRead + Unpin + Send>;
pub type Writer = Box<dyn AsyncWrite + Unpin + Send>;

#[cfg(unix)]
pub async fn connect(endpoint: &str) -> io::Result<(Reader, Writer)> {
    let stream = tokio::net::UnixStream::connect(endpoint).await?;
    let (reader, writer) = stream.into_split();
    Ok((Box::new(reader), Box::new(writer)))
}

#[cfg(windows)]
pub async fn connect(endpoint: &str) -> io::Result<(Reader, Writer)> {
    use std::time::Duration;

    use tokio::net::windows::named_pipe::ClientOptions;

    // Every instance busy: another agent's relay or hook is connecting this moment.
    const PIPE_BUSY: i32 = 231;
    let mut tries = 0;
    let pipe = loop {
        match ClientOptions::new().open(endpoint) {
            Ok(pipe) => break pipe,
            Err(error) if error.raw_os_error() == Some(PIPE_BUSY) && tries < 40 => {
                tries += 1;
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            Err(error) => return Err(error),
        }
    };
    let (reader, writer) = tokio::io::split(pipe);
    Ok((Box::new(reader), Box::new(writer)))
}
