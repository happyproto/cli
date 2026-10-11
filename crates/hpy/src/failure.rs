use hpy_plugin::Problem;

/// An error with its exit code: 1 runtime/remote, 2 usage/validation,
/// 3 not logged in.
#[derive(Debug)]
pub struct Failure {
    pub code: u8,
    pub report: miette::Report,
}

impl Failure {
    pub fn usage(msg: impl std::fmt::Display) -> Failure {
        Failure {
            code: 2,
            report: miette::miette!("{msg}"),
        }
    }

    pub fn runtime(msg: impl std::fmt::Display) -> Failure {
        Failure {
            code: 1,
            report: miette::miette!("{msg}"),
        }
    }

    pub fn not_logged_in() -> Failure {
        Failure {
            code: 3,
            report: miette::miette!("not logged in; run `hpy registry login`"),
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
        }
    }
}

impl From<Problem> for Failure {
    fn from(p: Problem) -> Failure {
        Failure::usage(p)
    }
}
