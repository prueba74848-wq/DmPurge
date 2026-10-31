(function () {
  const v = vendetta;
  const lazy = {};
  const get = (k, fn) => (k in lazy ? lazy[k] : (lazy[k] = fn()));
  const R = () => get("React", () => v.metro.common.React);
  const RNm = () => get("RN", () => v.metro.common.ReactNative);
  const findByStoreName = (n) => v.metro.findByStoreName(n);
  const RestAPI = new Proxy({}, {
    get: (_, k) => get("Rest", () => v.metro.findByProps("getAPIBaseURL", "get"))[k],
  });

  // Message types a user can delete: DEFAULT, REPLY, CHAT_INPUT_COMMAND, CONTEXT_MENU_COMMAND
  const DELETABLE = [0, 19, 20, 23];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  let running = false;
  let stopRequested = false;
  const unregister = [];

  function toast(text, icon) {
    try {
      let id;
      try {
        id = v.ui.assets.getAssetIDByName(icon);
      } catch (e) {}
      v.ui.toasts.showToast(text, id);
    } catch (e) {}
  }

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

    const UserStore = findByStoreName("UserStore");
    const ChannelStore = findByStoreName("ChannelStore");

    const channel = ChannelStore && ChannelStore.getChannel(channelId);
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
          "/channels/" + channelId + "/messages?limit=100" +
          (before ? "&before=" + before : "");
        const res = await api("get", url);
        const msgs = res.body || [];
        if (!msgs.length) break;
        before = msgs[msgs.length - 1].id;

        const mine = msgs.filter(
          (m) => m.author.id === me && DELETABLE.indexOf(m.type) !== -1
        );

        for (const m of mine) {
          if (stopRequested) break;
          try {
            await api("del", "/channels/" + channelId + "/messages/" + m.id);
            deleted++;
          } catch (e) {
            failed++;
          }
          if (onProgress) onProgress(deleted, failed);
          await sleep(350);
        }

        if (msgs.length < 100) break;
      }
    } finally {
      running = false;
    }
    return { deleted: deleted, failed: failed, stopped: stopRequested };
  }

  // Settings page built only from react-native primitives (no Forms dependency)
  function Settings() {
    const React = R();
    const RN = RNm();
    const [channelId, setChannelId] = React.useState("");
    const [status, setStatus] = React.useState("Idle");
    const h = React.createElement;

    const button = (label, onPress, color) =>
      h(
        RN.Pressable,
        {
          onPress: onPress,
          style: {
            backgroundColor: color,
            padding: 14,
            borderRadius: 8,
            marginTop: 12,
            alignItems: "center",
          },
        },
        h(RN.Text, { style: { color: "#fff", fontWeight: "bold" } }, label)
      );

    const start = () => {
      const id = channelId.trim();
      RN.Alert.alert(
        "Delete all your messages?",
        "This permanently deletes every message you sent in channel " + id + ". It cannot be undone.",
        [
          { text: "Cancel", style: "cancel" },
          {
            text: "Delete",
            style: "destructive",
            onPress: async () => {
              try {
                setStatus("Starting...");
                const r = await purge(id, (d, f) =>
                  setStatus("Deleted " + d + (f ? ", failed " + f : ""))
                );
                setStatus(
                  (r.stopped ? "Stopped" : "Done") + ": deleted " + r.deleted +
                    (r.failed ? ", failed " + r.failed : "")
                );
              } catch (e) {
                setStatus("Error: " + (e && e.message ? e.message : e));
              }
            },
          },
        ]
      );
    };

    return h(
      RN.ScrollView,
      { style: { padding: 16 } },
      h(RN.Text, { style: { color: "#fff", fontSize: 16, marginBottom: 8 } }, "DM channel ID"),
      h(RN.TextInput, {
        value: channelId,
        onChangeText: setChannelId,
        placeholder: "123456789012345678",
        placeholderTextColor: "#888",
        keyboardType: "numeric",
        style: {
          color: "#fff",
          backgroundColor: "#2b2d31",
          padding: 12,
          borderRadius: 8,
        },
      }),
      button("Delete all my messages in this DM", start, "#d83c3e"),
      button("Stop", () => { stopRequested = true; }, "#4e5058"),
      h(RN.Text, { style: { color: "#ccc", marginTop: 16 } }, status)
    );
  }

  return {
    onLoad: function () {
      try {
        const reg = v.commands && v.commands.registerCommand;
        if (!reg) return;
        unregister.push(
          reg({
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
            execute: function (args) {
              const id = String(args[0].value).trim();
              toast("DM Purge started", "Check");
              purge(id)
                .then((r) =>
                  toast(
                    "Deleted " + r.deleted + " message(s)" +
                      (r.failed ? ", " + r.failed + " failed" : ""),
                    "Check"
                  )
                )
                .catch((e) =>
                  toast("DM Purge: " + (e && e.message ? e.message : e), "Small")
                );
            },
          })
        );
      } catch (e) {
        toast("DM Purge: command not registered (" + (e && e.message) + ")", "Small");
      }
    },
    onUnload: function () {
      stopRequested = true;
      unregister.forEach((u) => { try { u(); } catch (e) {} });
      unregister.length = 0;
    },
    settings: Settings,
  };
})()
