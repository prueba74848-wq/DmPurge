(function () {
  const { findByProps, findByStoreName } = vendetta.metro;
  const { React, ReactNative } = vendetta.metro.common;
  const { Forms } = vendetta.ui.components;
  const { showToast } = vendetta.ui.toasts;
  const { registerCommand } = vendetta.commands;
  const { getAssetIDByName } = vendetta.ui.assets;

  const RestAPI = findByProps("getAPIBaseURL", "get");
  const UserStore = findByStoreName("UserStore");
  const ChannelStore = findByStoreName("ChannelStore");

  const { FormSection, FormInput, FormRow, FormText } = Forms;

  // Message types a user can delete: DEFAULT, REPLY, CHAT_INPUT_COMMAND, CONTEXT_MENU_COMMAND
  const DELETABLE = [0, 19, 20, 23];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  let running = false;
  let stopRequested = false;
  const unregister = [];

  async function api(method, url) {
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        return await RestAPI[method]({ url });
      } catch (e) {
        if (e && e.status === 429) {
          const wait = ((e.body && e.body.retry_after) || 2) * 1000 + 250;
          await sleep(wait);
          continue;
        }
        throw e;
      }
    }
    throw new Error("Rate limited too many times");
  }

  async function purge(channelId, onProgress) {
    if (running) throw new Error("Already running");
    if (!/^\d{17,20}$/.test(channelId)) throw new Error("Invalid channel ID");

    const channel = ChannelStore.getChannel(channelId);
    if (channel && channel.type !== 1 && channel.type !== 3) {
      throw new Error("That channel is not a DM");
    }

    const me = UserStore.getCurrentUser().id;
    running = true;
    stopRequested = false;
    let deleted = 0;
    let failed = 0;
    let before = null;

    try {
      while (!stopRequested) {
        const url =
          `/channels/${channelId}/messages?limit=100` +
          (before ? `&before=${before}` : "");
        const res = await api("get", url);
        const msgs = res.body || [];
        if (!msgs.length) break;
        before = msgs[msgs.length - 1].id;

        const mine = msgs.filter(
          (m) => m.author.id === me && DELETABLE.includes(m.type)
        );

        for (const m of mine) {
          if (stopRequested) break;
          try {
            await api("del", `/channels/${channelId}/messages/${m.id}`);
            deleted++;
          } catch (e) {
            failed++;
          }
          onProgress && onProgress(deleted, failed);
          await sleep(350);
        }

        if (msgs.length < 100) break;
      }
    } finally {
      running = false;
    }
    return { deleted, failed, stopped: stopRequested };
  }

  function Settings() {
    const [channelId, setChannelId] = React.useState("");
    const [status, setStatus] = React.useState("Idle");

    const start = () => {
      const id = channelId.trim();
      ReactNative.Alert.alert(
        "Delete all your messages?",
        `This permanently deletes every message you sent in channel ${id}. It cannot be undone.`,
        [
          { text: "Cancel", style: "cancel" },
          {
            text: "Delete",
            style: "destructive",
            onPress: async () => {
              try {
                setStatus("Starting...");
                const r = await purge(id, (d, f) =>
                  setStatus(`Deleted ${d}` + (f ? `, failed ${f}` : ""))
                );
                setStatus(
                  `${r.stopped ? "Stopped" : "Done"}: deleted ${r.deleted}` +
                    (r.failed ? `, failed ${r.failed}` : "")
                );
              } catch (e) {
                setStatus("Error: " + (e && e.message ? e.message : e));
              }
            },
          },
        ]
      );
    };

    return React.createElement(
      ReactNative.ScrollView,
      null,
      React.createElement(
        FormSection,
        { title: "DM Purge", titleStyleType: "no_border" },
        React.createElement(FormInput, {
          title: "DM channel ID",
          placeholder: "e.g. 123456789012345678",
          value: channelId,
          onChange: setChannelId,
          keyboardType: "numeric",
        }),
        React.createElement(FormRow, {
          label: "Delete all my messages in this DM",
          onPress: start,
        }),
        React.createElement(FormRow, {
          label: "Stop",
          onPress: () => {
            stopRequested = true;
          },
        }),
        React.createElement(FormText, { style: { padding: 16 } }, status)
      )
    );
  }

  return {
    onLoad() {
      unregister.push(
        registerCommand({
          name: "purgedm",
          displayName: "purgedm",
          description: "Delete all your messages in a DM by channel ID",
          displayDescription: "Delete all your messages in a DM by channel ID",
          applicationId: "-1",
          inputType: 1,
          type: 1,
          options: [
            {
              name: "channel_id",
              displayName: "channel_id",
              description: "ID of the DM channel",
              displayDescription: "ID of the DM channel",
              required: true,
              type: 3,
            },
          ],
          execute(args) {
            const id = String(args[0].value).trim();
            purge(id)
              .then((r) =>
                showToast(
                  `Deleted ${r.deleted} message(s)` +
                    (r.failed ? `, ${r.failed} failed` : ""),
                  getAssetIDByName("Check")
                )
              )
              .catch((e) =>
                showToast(
                  "DM Purge: " + (e && e.message ? e.message : e),
                  getAssetIDByName("Small")
                )
              );
            showToast("DM Purge started", getAssetIDByName("Check"));
          },
        })
      );
    },
    onUnload() {
      stopRequested = true;
      unregister.forEach((u) => u());
      unregister.length = 0;
    },
    settings: Settings,
  };
})()
