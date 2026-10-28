use std::io::IsTerminal;

use crate::failure::Failure;

/// Flag value, else a prompt (only with a terminal), else the default, else
/// an error naming the flag. Nothing here ever blocks without a TTY.
pub struct Prompter {
    interactive: bool,
    /// Why there is no prompting, for the error that names a missing flag.
    why_not: &'static str,
}

fn prompt_err(e: inquire::InquireError) -> Failure {
    match e {
        inquire::InquireError::OperationCanceled | inquire::InquireError::OperationInterrupted => {
            Failure::runtime("cancelled")
        }
        e => Failure::runtime(e),
    }
}

impl Prompter {
    pub fn new(no_input: bool) -> Prompter {
        let terminal = std::io::stdin().is_terminal() && std::io::stderr().is_terminal();
        Prompter {
            interactive: !no_input && terminal,
            why_not: if no_input {
                "--no-input was given"
            } else {
                "no terminal to prompt on"
            },
        }
    }

    pub fn is_interactive(&self) -> bool {
        self.interactive
    }

    pub fn required(
        &self,
        flag: &str,
        label: &str,
        given: Option<String>,
        default: Option<String>,
        check: fn(&str) -> Result<(), String>,
    ) -> Result<String, Failure> {
        if let Some(v) = given {
            check(&v).map_err(|e| Failure::usage(format!("{flag}: {e}")))?;
            return Ok(v);
        }
        if self.interactive {
            let mut p = inquire::Text::new(label).with_validator(move |s: &str| {
                Ok(match check(s) {
                    Ok(()) => inquire::validator::Validation::Valid,
                    Err(e) => inquire::validator::Validation::Invalid(e.into()),
                })
            });
            if let Some(d) = &default {
                p = p.with_default(d);
            }
            return p.prompt().map_err(prompt_err);
        }
        match default {
            Some(d) => {
                check(&d)
                    .map_err(|e| Failure::usage(format!("{flag} (defaulted to `{d}`): {e}")))?;
                Ok(d)
            }
            None => Err(Failure::usage(format!("missing {flag} ({})", self.why_not))),
        }
    }

    pub fn optional(
        &self,
        label: &str,
        given: Option<String>,
        default: Option<String>,
    ) -> Result<Option<String>, Failure> {
        if given.is_some() {
            return Ok(given);
        }
        if self.interactive {
            let mut p =
                inquire::Text::new(label).with_help_message("optional; leave blank to skip");
            if let Some(d) = &default {
                p = p.with_default(d);
            }
            let v = p.prompt().map_err(prompt_err)?;
            return Ok(Some(v).filter(|s| !s.trim().is_empty()));
        }
        Ok(default)
    }

    /// A repeated value: flags if any were given, else prompt one per line
    /// (blank to finish), else the defaults. Fewer than `min` is an error.
    pub fn list<T>(
        &self,
        flag: &str,
        label: &str,
        given: Vec<String>,
        default: Vec<T>,
        parse: fn(&str) -> Result<T, String>,
        min: usize,
    ) -> Result<Vec<T>, Failure> {
        let items: Vec<T> = if !given.is_empty() {
            given
                .iter()
                .map(|s| parse(s).map_err(|e| Failure::usage(format!("{flag}: {e}"))))
                .collect::<Result<_, _>>()?
        } else if self.interactive && default.is_empty() {
            let mut out = Vec::new();
            loop {
                let help = if out.len() < min {
                    "required"
                } else {
                    "leave blank to finish"
                };
                let s = inquire::Text::new(label)
                    .with_help_message(help)
                    .prompt()
                    .map_err(prompt_err)?;
                if s.trim().is_empty() {
                    if out.len() >= min {
                        break;
                    }
                    continue;
                }
                match parse(&s) {
                    Ok(v) => out.push(v),
                    Err(e) => eprintln!("  {e}"),
                }
            }
            out
        } else {
            default
        };
        if items.len() < min {
            return Err(Failure::usage(format!("missing {flag} ({})", self.why_not)));
        }
        Ok(items)
    }

    /// Several of `options`: flags if any were given (checked against the
    /// options when there are any), else a checklist with `preselected`
    /// ticked, else `preselected`.
    pub fn multi(
        &self,
        flag: &str,
        label: &str,
        given: Vec<String>,
        options: &[String],
        preselected: &[String],
    ) -> Result<Vec<String>, Failure> {
        if !given.is_empty() {
            if !options.is_empty()
                && let Some(bad) = given.iter().find(|g| !options.contains(g))
            {
                return Err(Failure::usage(format!(
                    "{flag}: `{bad}` is not one of {}",
                    options.join(", ")
                )));
            }
            return Ok(given);
        }
        if self.interactive && !options.is_empty() {
            let defaults: Vec<usize> = options
                .iter()
                .enumerate()
                .filter(|(_, o)| preselected.contains(o))
                .map(|(i, _)| i)
                .collect();
            return inquire::MultiSelect::new(label, options.to_vec())
                .with_default(&defaults)
                .prompt()
                .map_err(prompt_err);
        }
        Ok(preselected.to_vec())
    }

    /// One of `options`, by index: a prompt with a terminal, otherwise an
    /// error listing them and naming the flag that decides.
    pub fn choose(&self, flag: &str, label: &str, options: &[String]) -> Result<usize, Failure> {
        if self.interactive {
            return inquire::Select::new(label, options.to_vec())
                .raw_prompt()
                .map(|o| o.index)
                .map_err(prompt_err);
        }
        let list: Vec<String> = options.iter().map(|o| format!("  • {o}")).collect();
        Err(Failure::usage(format!(
            "{label} pass {flag} to choose ({}):\n{}",
            self.why_not,
            list.join("\n")
        )))
    }

    /// A secret typed at a hidden prompt; without a terminal, an error naming
    /// `instead`, the way to give it otherwise.
    pub fn secret(&self, instead: &str, label: &str) -> Result<String, Failure> {
        if self.interactive {
            return inquire::Password::new(label)
                .without_confirmation()
                .with_display_mode(inquire::PasswordDisplayMode::Hidden)
                .prompt()
                .map_err(prompt_err);
        }
        Err(Failure::usage(format!(
            "{label} cannot be asked for ({}); use {instead}",
            self.why_not
        )))
    }

    pub fn confirm(&self, label: &str, yes: bool) -> Result<bool, Failure> {
        if yes {
            return Ok(true);
        }
        if self.interactive {
            return inquire::Confirm::new(label)
                .with_default(false)
                .prompt()
                .map_err(prompt_err);
        }
        Err(Failure::usage("pass --yes to confirm without a terminal"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ok(_: &str) -> Result<(), String> {
        Ok(())
    }

    #[test]
    fn says_why_it_cannot_prompt() {
        let err = Prompter::new(true)
            .required("--license", "License:", None, None, ok)
            .err()
            .unwrap();
        assert!(
            format!("{:?}", err.report).contains("--no-input"),
            "{:?}",
            err.report
        );
        // tests run without a terminal
        let err = Prompter::new(false)
            .required("--license", "License:", None, None, ok)
            .err()
            .unwrap();
        assert!(
            format!("{:?}", err.report).contains("no terminal"),
            "{:?}",
            err.report
        );
    }

    #[test]
    fn choose_without_a_terminal_names_the_flag_and_lists_the_options() {
        let err = Prompter::new(true)
            .choose("--package", "Which `lua`?", &["one".into(), "two".into()])
            .unwrap_err();
        let msg = format!("{:?}", err.report);
        assert!(
            msg.contains("--package") && msg.contains("one") && msg.contains("two"),
            "{msg}"
        );
        assert_eq!(err.code, 2);
    }

    #[test]
    fn multi_uses_flags_then_the_preselection() {
        let p = Prompter::new(true);
        let options = vec!["lua".to_string(), "javascript".to_string()];
        assert_eq!(
            p.multi(
                "--interpreter",
                "Interpreters:",
                vec![],
                &options,
                &["lua".into()]
            )
            .unwrap(),
            ["lua"]
        );
        assert_eq!(
            p.multi(
                "--interpreter",
                "Interpreters:",
                vec!["javascript".into()],
                &options,
                &["lua".into()]
            )
            .unwrap(),
            ["javascript"]
        );
        let err = p
            .multi(
                "--interpreter",
                "Interpreters:",
                vec!["python".into()],
                &options,
                &[],
            )
            .unwrap_err();
        let msg = format!("{:?}", err.report);
        assert!(
            msg.contains("--interpreter: `python`") && msg.contains("lua, javascript"),
            "{msg}"
        );
    }

    #[test]
    fn multi_takes_any_flag_value_when_nothing_was_listed() {
        let p = Prompter::new(true);
        assert_eq!(
            p.multi("--library", "Libraries:", vec!["x".into()], &[], &[])
                .unwrap(),
            ["x"]
        );
    }
}
