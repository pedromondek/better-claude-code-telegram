#[cfg(unix)]
#[path = "../tests/support/pty.rs"]
mod pty;

#[cfg(unix)]
fn main() -> Result<(), Box<dyn std::error::Error>> {
    use std::io::{Read, Write};
    use std::path::PathBuf;

    use serde_json::{Value, json};

    let mut input = String::new();

    std::io::stdin().read_to_string(&mut input)?;

    let spec: Value = serde_json::from_str(&input)?;
    let strings = |value: &Value| -> Vec<String> {
        value
            .as_array()
            .map(|items| {
                items
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default()
    };
    let size = |key: &str| -> u16 {
        spec.get(key)
            .and_then(Value::as_u64)
            .and_then(|value| u16::try_from(value).ok())
            .unwrap_or_default()
    };
    let argv = strings(spec.get("argv").unwrap_or(&Value::Null));
    let env: Vec<(String, String)> = spec
        .get("env")
        .and_then(Value::as_object)
        .map(|variables| {
            variables
                .iter()
                .map(|(name, value)| (name.clone(), value.as_str().unwrap_or_default().to_owned()))
                .collect()
        })
        .unwrap_or_default();
    let steps: Vec<pty::Step> = spec
        .get("steps")
        .and_then(Value::as_array)
        .map(|steps| {
            steps
                .iter()
                .map(|step| {
                    if let Some(columns) = step.get("resize").and_then(Value::as_u64) {
                        return pty::Step::Resize(u16::try_from(columns).unwrap_or_default());
                    }

                    if let Some(milliseconds) = step.get("pause").and_then(Value::as_u64) {
                        return pty::Step::Pause(milliseconds);
                    }

                    let key = step
                        .get("key")
                        .and_then(Value::as_array)
                        .map(|bytes| {
                            bytes
                                .iter()
                                .filter_map(Value::as_u64)
                                .filter_map(|byte| u8::try_from(byte).ok())
                                .collect()
                        })
                        .unwrap_or_default();

                    match step.get("when").and_then(Value::as_str) {
                        Some(needle) => pty::Step::When(needle.as_bytes().to_vec(), key),
                        None => pty::Step::Key(key),
                    }
                })
                .collect()
        })
        .unwrap_or_default();
    let redirect = spec
        .get("redirect")
        .and_then(Value::as_str)
        .map(PathBuf::from);
    let output = pty::record(&pty::Run {
        argv: &argv,
        env: &env,
        columns: size("columns"),
        rows: size("rows"),
        steps: &steps,
        redirect: redirect.as_deref().map(pty::Redirect::File),
    })?;

    std::io::stdout().write_all(json!({ "output": output }).to_string().as_bytes())?;
    Ok(())
}

#[cfg(not(unix))]
fn main() {}
