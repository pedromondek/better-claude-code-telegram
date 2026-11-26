use bcct::self_install::Channel;

pub(crate) fn built_version_notice() -> String {
    let channel = Channel::of(env!("CARGO_PKG_VERSION"));

    if channel.is_unstable() {
        format!(
            "⚠ Test version ({}). For the stable one: 'bcct update stable'.\n",
            channel.name()
        )
    } else {
        String::new()
    }
}
