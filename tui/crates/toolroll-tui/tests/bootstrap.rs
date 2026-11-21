//! Disabled central bootstrap: pure schema/secret guards plus actual native protected-FD startup, never remote work.
use serde_json::{json, Value};
use std::io::Cursor;
use toolroll_tui::bootstrap::{self, Bootstrap, BootstrapError, MAX_BOOTSTRAP_BYTES};

const LOCAL: &str = "http://127.0.0.1:43123/login/once/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

fn fixture() -> Value {
    json!({"bootstrap":1,"kind":"central-token","connectionProtocol":1,"origin":"https://toolroll.example.com",
        "binding":{"kind":"enrolled-person","workspaceId":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            "recoveryGeneration":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","account":"alice"},
        "token":format!("so_aaaaaaaaaaaa_{}","A".repeat(43))})
}

fn central(value: &Value) -> Result<Option<Bootstrap>, BootstrapError> {
    bootstrap::parse(&value.to_string())
}

#[test]
fn legacy_plain_link_and_first_line_trim_behavior_are_preserved() {
    for input in [
        LOCAL.to_owned(),
        format!(" {LOCAL} \n"),
        format!("{LOCAL}\nignored legacy second line"),
    ] {
        let Some(Bootstrap::LocalLink(link)) = bootstrap::read(Cursor::new(input)).unwrap() else {
            panic!("not legacy")
        };
        assert_eq!(link.as_str(), LOCAL);
    }
    assert!(bootstrap::read(Cursor::new("")).unwrap().is_none());
    assert!(bootstrap::read(Cursor::new("\n")).unwrap().is_none());
    // The old native path lets redeem reject a non-link; it is not reclassified as a usable central connection.
    assert!(matches!(
        bootstrap::parse("not a link").unwrap(),
        Some(Bootstrap::LocalLink(_))
    ));
}

#[test]
fn valid_central_input_yields_redacted_central_token_bootstrap() {
    let parsed = central(&fixture()).unwrap().unwrap();
    assert!(matches!(parsed, Bootstrap::CentralToken(_)));
    let shown = format!("{parsed:?}");
    assert_eq!(shown, "Bootstrap::CentralToken(<held>)");
    assert!(!shown.contains("so_"));
    assert!(!shown.contains("alice"));
    let local = bootstrap::parse(LOCAL).unwrap().unwrap();
    assert!(!format!("{local:?}").contains("login/once"));
}

#[test]
fn escaped_structured_keys_prefixes_and_token_values_are_refused_before_decoding() {
    let raw = fixture().to_string();
    for escaped in [
        raw.replace("so_aaaaaaaaaaaa_", "\\u0073o_aaaaaaaaaaaa_"),
        raw.replace(&"A".repeat(43), &format!("\\u0041{}", "A".repeat(42))),
        raw.replace("\"token\":", "\"to\\u006ben\":"),
        raw.replace("\"alice\"", "\"ali\\u0063e\""),
    ] {
        let error = bootstrap::read(Cursor::new(escaped)).unwrap_err();
        assert_eq!(error, BootstrapError::Invalid);
        assert!(!format!("{error:?} {error}").contains("so_"));
    }
    // Literal UTF-8 is not an escape and retains the shared account scalar contract.
    let mut unicode = fixture();
    unicode["binding"]["account"] = json!("alice 日本語 🦀");
    assert!(central(&unicode).is_ok());
    // This restriction is only for the structured discriminator: legacy plain input is still handed unchanged to
    // local redemption, which owns whether a link is valid.
    let legacy = format!("{LOCAL}\\literal");
    let Some(Bootstrap::LocalLink(link)) = bootstrap::parse(&legacy).unwrap() else {
        panic!("legacy input reclassified")
    };
    assert_eq!(link.as_str(), legacy);
}

#[test]
fn unknown_duplicate_missing_and_inconsistent_fields_never_become_local_links() {
    let raw = fixture().to_string();
    for duplicate in [
        raw.replace("\"bootstrap\":1", "\"bootstrap\":1,\"bootstrap\":1"),
        raw.replace("\"token\":", "\"token\":\"so_SECRET_SENTINEL\",\"token\":"),
        raw.replace(
            "\"account\":\"alice\"",
            "\"account\":\"alice\",\"account\":\"bob\"",
        ),
    ] {
        assert_eq!(
            bootstrap::parse(&duplicate).unwrap_err(),
            BootstrapError::Invalid
        );
    }
    for path in ["", "/binding"] {
        let fields: Vec<_> = fixture()
            .pointer(path)
            .unwrap()
            .as_object()
            .unwrap()
            .keys()
            .cloned()
            .collect();
        for field in fields {
            let mut value = fixture();
            value
                .pointer_mut(path)
                .unwrap()
                .as_object_mut()
                .unwrap()
                .remove(&field);
            assert_eq!(
                central(&value).unwrap_err(),
                BootstrapError::Invalid,
                "missing {path}/{field}"
            );
        }
        let mut value = fixture();
        value
            .pointer_mut(path)
            .unwrap()
            .as_object_mut()
            .unwrap()
            .insert("secret".into(), json!("so_SECRET_SENTINEL"));
        assert_eq!(central(&value).unwrap_err(), BootstrapError::Invalid);
    }
    for (path, value) in [
        ("/kind", json!("local-link")),
        ("/binding/kind", json!("server-metadata")),
        ("/kind", json!("unknown")),
        ("/token", json!(null)),
        ("/bootstrap", json!("1")),
        ("/connectionProtocol", json!(1.5)),
    ] {
        let mut input = fixture();
        *input.pointer_mut(path).unwrap() = value;
        assert_eq!(
            central(&input).unwrap_err(),
            BootstrapError::Invalid,
            "{path}"
        );
    }
    for field in ["bootstrap", "connectionProtocol"] {
        let mut input = fixture();
        input[field] = json!(2);
        assert_eq!(central(&input).unwrap_err(), BootstrapError::Unsupported);
    }
    for input in ["{", "[]", "{\"kind\":\"central-token\"}\n{}"] {
        assert_eq!(
            bootstrap::parse(input).unwrap_err(),
            BootstrapError::Invalid
        );
    }
}

#[test]
fn central_origin_must_be_exact_canonical_https_without_authority_or_path_confusion() {
    for origin in [
        "https://toolroll.example.com",
        "https://127.0.0.1:44123",
        "https://[::1]:44123",
    ] {
        let mut value = fixture();
        value["origin"] = json!(origin);
        assert!(central(&value).is_ok());
    }
    for origin in [
        "http://127.0.0.1:44123",
        "http://toolroll.example.com",
        "https://user:secret@toolroll.example.com",
        "https://toolroll.example.com/",
        "https://toolroll.example.com/path",
        "https://toolroll.example.com?x=1",
        "https://toolroll.example.com#x",
        "https://TOOLROLL.example.com",
        "https://toolroll.example.com:443",
        " https://toolroll.example.com",
        "https://toolroll.example.com\n",
        "https://toolroll.example.com\\evil",
        "data:text/plain,secret",
        "https://",
        "https://127.1",
        "https://0x7f000001",
        "https://%74oolroll.example.com",
    ] {
        let mut value = fixture();
        value["origin"] = json!(origin);
        assert_eq!(
            central(&value).unwrap_err(),
            BootstrapError::Invalid,
            "{origin}"
        );
    }
}

#[test]
fn binding_and_credential_shapes_are_distinct_and_closed() {
    for (path, value) in [
        (
            "/binding/workspaceId",
            json!("AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA"),
        ),
        (
            "/binding/workspaceId",
            json!("aaaaaaaa-aaaa-3aaa-8aaa-aaaaaaaaaaaa"),
        ),
        ("/binding/recoveryGeneration", json!("B".repeat(32))),
        ("/binding/account", json!("alice\u{202e}")),
        ("/binding/account", json!("")),
        (
            "/token",
            json!("lt_aaaaaaaaaaaa_".to_owned() + &"A".repeat(43)),
        ),
        (
            "/token",
            json!("so_aaaaaaaaaaaa_".to_owned() + &"A".repeat(42)),
        ),
        (
            "/token",
            json!("so_AAAAAAAAAAAA_".to_owned() + &"A".repeat(43)),
        ),
        (
            "/token",
            json!("so_aaaaaaaaaaaa_".to_owned() + &"/".repeat(43)),
        ),
    ] {
        let mut input = fixture();
        *input.pointer_mut(path).unwrap() = value;
        assert_eq!(
            central(&input).unwrap_err(),
            BootstrapError::Invalid,
            "{path}"
        );
    }
    let mut input = fixture();
    input["binding"]["account"] = json!("🦀".repeat(200));
    assert!(central(&input).is_ok());
    input["binding"]["account"] = json!("🦀".repeat(201));
    assert_eq!(central(&input).unwrap_err(), BootstrapError::Invalid);
}

#[test]
fn bounded_io_invalid_utf8_and_errors_do_not_echo_the_payload() {
    let huge = format!("{}{}", fixture(), " ".repeat(MAX_BOOTSTRAP_BYTES));
    assert_eq!(
        bootstrap::read(Cursor::new(huge)).unwrap_err(),
        BootstrapError::TooLarge
    );
    assert_eq!(
        bootstrap::read(Cursor::new([0xff])).unwrap_err(),
        BootstrapError::Invalid
    );
    struct Broken;
    impl std::io::Read for Broken {
        fn read(&mut self, _: &mut [u8]) -> std::io::Result<usize> {
            Err(std::io::Error::other("so_SECRET_SENTINEL"))
        }
    }
    let error = bootstrap::read(Broken).unwrap_err();
    assert_eq!(error, BootstrapError::Unreadable);
    assert!(!format!("{error:?} {error}").contains("SECRET_SENTINEL"));
}

#[cfg(unix)]
mod native {
    use super::*;
    use std::fs::{self, File};
    use std::io::{BufRead, BufReader, Write};
    use std::net::TcpListener;
    use std::os::fd::{FromRawFd, RawFd};
    use std::os::unix::fs::DirBuilderExt;
    use std::os::unix::process::CommandExt;
    use std::path::PathBuf;
    use std::process::{Child, Command, Output, Stdio};
    use std::sync::atomic::{AtomicU64, Ordering};
    use toolroll_tui::bootstrap::EXIT_CENTRAL_UNAVAILABLE;
    use toolroll_tui::guard::READY_LINE;

    const BIN: &str = env!("CARGO_BIN_EXE_toolroll-tui");
    static NEXT: AtomicU64 = AtomicU64::new(0);

    struct OwnedChild(Option<Child>);
    impl Drop for OwnedChild {
        fn drop(&mut self) {
            if let Some(child) = self.0.as_mut() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }

    fn root() -> PathBuf {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../evidence/central-workspace/tui-bootstrap/native")
            .join(format!(
                "{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
        fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(&root)
            .unwrap();
        root
    }

    fn run(body: &[u8]) -> (Output, PathBuf) {
        let root = root();
        let mut link = [0 as RawFd; 2];
        let mut control = [0 as RawFd; 2];
        // SAFETY: new test-owned descriptor pairs, immediately moved to close-on-exec high descriptors.
        unsafe {
            assert_eq!(libc::pipe(link.as_mut_ptr()), 0);
            assert_eq!(
                libc::socketpair(libc::AF_UNIX, libc::SOCK_STREAM, 0, control.as_mut_ptr()),
                0
            );
        }
        let high = |fd| {
            let out = unsafe { libc::fcntl(fd, libc::F_DUPFD_CLOEXEC, 100) };
            assert!(out >= 100);
            unsafe { libc::close(fd) };
            out
        };
        let (link_read, link_write, ours, theirs) = (
            high(link[0]),
            high(link[1]),
            high(control[0]),
            high(control[1]),
        );
        let mut cmd = Command::new(BIN);
        cmd.args(["--control-fd", "4"])
            .env_clear()
            .env("HOME", &root)
            .env("XDG_CONFIG_HOME", root.join("config"))
            .env("XDG_STATE_HOME", root.join("state"))
            .env("TMPDIR", &root)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        // SAFETY: only dup2/close between fork and exec, and the child owns its copies at the designated descriptors.
        unsafe {
            cmd.pre_exec(move || {
                if libc::dup2(link_read, 3) < 0 || libc::dup2(theirs, 4) < 0 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
        let mut child = OwnedChild(Some(cmd.spawn().unwrap()));
        unsafe {
            libc::close(link_read);
            libc::close(theirs);
        }
        let mut writer = unsafe { File::from_raw_fd(link_write) };
        let mut ready = BufReader::new(unsafe { File::from_raw_fd(ours) });
        let mut line = String::new();
        ready.read_line(&mut line).unwrap();
        // No secret was sent until the actual native binary said protection is installed.
        assert_eq!(line, READY_LINE);
        let _ = writer.write_all(body);
        drop(writer);
        drop(ready);
        let output = child.0.take().unwrap().wait_with_output().unwrap();
        (output, root)
    }

    #[test]
    fn actual_central_start_with_unreachable_origin_exits_unavailable_without_local_fallback() {
        let trap = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = trap.local_addr().unwrap().port();
        drop(trap);
        let mut value = fixture();
        value["origin"] = json!(format!("https://127.0.0.1:{port}"));
        let (output, root) = run(value.to_string().as_bytes());
        assert_eq!(output.status.code(), Some(EXIT_CENTRAL_UNAVAILABLE));
        let err = String::from_utf8(output.stderr).unwrap();
        assert!(
            err.contains("Couldn't connect to central workspace"),
            "{err}"
        );
        assert!(!err.contains("so_"));
        assert!(!err.contains("classic"));
        assert!(output.stdout.is_empty());
        assert!(!root.join("config").exists());
        assert!(!root.join("state").exists());
    }

    #[test]
    fn actual_malformed_or_unsupported_central_input_never_requests_classic_or_exposes_a_token() {
        let mut wrong = fixture();
        wrong["connectionProtocol"] = json!(2);
        let mut unknown = fixture();
        unknown["kind"] = json!("local-link");
        for body in [
            "{".to_owned(),
            "[]".to_owned(),
            wrong.to_string(),
            unknown.to_string(),
            fixture()
                .to_string()
                .replace("so_aaaaaaaaaaaa_", "\\u0073o_aaaaaaaaaaaa_"),
            fixture()
                .to_string()
                .replace(&"A".repeat(43), &format!("\\u0041{}", "A".repeat(42))),
            format!("{}{}", fixture(), " ".repeat(MAX_BOOTSTRAP_BYTES)),
        ] {
            let (output, _) = run(body.as_bytes());
            assert_eq!(output.status.code(), Some(EXIT_CENTRAL_UNAVAILABLE));
            let error = String::from_utf8(output.stderr).unwrap();
            assert!(!error.contains("so_"));
            assert!(!error.contains("classic"));
        }
    }

    #[test]
    fn actual_invalid_legacy_link_keeps_its_existing_classic_exit() {
        let (output, _) = run(b"not a link\n");
        assert_eq!(output.status.code(), Some(toolroll_tui::app::EXIT_CLASSIC));
    }
}
