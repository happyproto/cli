use hpy_plugin::Problem;

/// An error with its exit code: 1 runtime/remote, 2 usage/validation,
/// 3 not logged in.
#[derive(Debug)]
pub struct Failure {
    pub code: u8,
    pub report: miette::Report,
    /// Already explained on the terminal, by a child process whose output
    /// went straight there, so `main` prints nothing more.
    pub quiet: bool,
}

impl Failure {
    pub fn usage(msg: impl std::fmt::Display) -> Failure {
        Failure {
            code: 2,
            report: miette::miette!("{msg}"),
            quiet: false,
        }
    }

    pub fn runtime(msg: impl std::fmt::Display) -> Failure {
        Failure {
            code: 1,
            report: miette::miette!("{msg}"),
            quiet: false,
        }
    }

    pub fn not_logged_in() -> Failure {
        Failure {
            code: 3,
            report: miette::miette!("not logged in; run `hpy registry login`"),
            quiet: false,
        }
    }

    pub fn exit(code: u8) -> Failure {
        Failure {
            code,
            report: miette::miette!("exited with {code}"),
            quiet: true,
        }
    }

    pub fn problems(intro: &str, problems: &[Problem]) -> Failure {
        let list: Vec<String> = problems.iter().map(|p| format!("  • {p}")).collect();
        Failure::usage(format!("{intro}\n{}", list.join("\n")))
    }
}

impl From<hpy_atproto::Error> for Failure {
    fn from(e: hpy_atproto::Error) -> Failure {
        let code = if e.is_auth() {
            3
        } else if e.is_usage() {
            2
        } else {
            1
        };
        Failure {
            code,
            report: miette::miette!("{e}"),
            quiet: false,
        }
    }
}

impl From<Problem> for Failure {
    fn from(p: Problem) -> Failure {
        Failure::usage(p)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A lexicon refusal is the publisher's to fix, like the registry's own
    /// refusals, so it exits 2 and prints the message the gateway wrote
    /// rather than wrapping it in a transport error.
    #[test]
    fn a_lexicon_refusal_is_a_usage_failure() {
        let f = Failure::from(hpy_atproto::Error::Registry {
            name: "InvalidRequest".into(),
            message: "Input/project/security must not have fewer than 1 elements".into(),
        });
        assert_eq!(f.code, 2);
        assert_eq!(
            f.report.to_string(),
            "Input/project/security must not have fewer than 1 elements"
        );
    }

    #[test]
    fn exit_failures_are_quiet_and_others_are_not() {
        let f = Failure::exit(7);
        assert_eq!(f.code, 7);
        assert!(f.quiet);
        assert!(!Failure::usage("x").quiet);
        assert!(!Failure::runtime("x").quiet);
    }
}
