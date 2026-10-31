(function () {
  var v = vendetta;
  var lazy = {};
  function get(k, fn) {
    return k in lazy ? lazy[k] : (lazy[k] = fn());
  }
  function R() { return get("React", function () { return v.metro.common.React; }); }
  function RNm() { return get("RN", function () { return v.metro.common.ReactNative; }); }
  function Rest() {
    return get("Rest", function () { return v.metro.findByProps("getAPIBaseURL", "get"); });
  }

  // Message types a user can delete: DEFAULT, REPLY, CHAT_INPUT_COMMAND, CONTEXT_MENU_COMMAND
  var DELETABLE = [0, 19, 20, 23];
  function sleep(ms) {
    return new Promise(function (r) { setTimeout(r, ms); });
  }

  var running = false;
  var stopRequested = false;
  var unregister = [];

  function toast(text, icon) {
    try {
      var id;
      try { id = v.ui.assets.getAssetIDByName(icon); } catch (e) {}
      v.ui.toasts.showToast(text, id);
    } catch (e) {}
  }

  // Promise-based (no async/await: Hermes eval does not support it)
  function api(method, url, attempt) {
    attempt = attempt || 0;
    return Promise.resolve()
      .then(function () { return Rest()[method]({ url: url }); })
      .catch(function (e) {
        if (e && e.status === 429 && attempt < 6) {
          var wait = ((e.body && e.body.retry_after) || 2) * 1000 + 250;
          return sleep(wait).then(function () { return api(method, url, attempt + 1); });
        }
        throw e;
      });
  }

  function purge(channelId, onProgress) {
    if (running) return Promise.reject(new Error("Already running"));
    if (!/^\d{17,20}$/.test(channelId)) return Promise.reject(new Error("Invalid channel ID"));

    var me, channel;
    try {
      var UserStore = v.metro.findByStoreName("UserStore");
      var ChannelStore = v.metro.findByStoreName("ChannelStore");
      channel = ChannelStore && ChannelStore.getChannel(channelId);
      me = UserStore.getCurrentUser().id;
    } catch (e) {
      return Promise.reject(e);
    }
    if (channel && channel.type !== 1 && channel.type !== 3) {
      return Promise.reject(new Error("That channel is not a DM"));
    }

    running = true;
    stopRequested = false;
    var deleted = 0;
    var failed = 0;
    var before = null;

    return new Promise(function (resolve, reject) {
      function finish() {
        running = false;
        resolve({ deleted: deleted, failed: failed, stopped: stopRequested });
      }
      function fail(e) {
        running = false;
        reject(e);
      }

      function nextPage() {
        if (stopRequested) return finish();
        var url =
          "/channels/" + channelId + "/messages?limit=100" +
          (before ? "&before=" + before : "");
        api("get", url)
          .then(function (res) {
            var msgs = res.body || [];
            if (!msgs.length) return finish();
            before = msgs[msgs.length - 1].id;

            var mine = msgs.filter(function (m) {
              return m.author.id === me && DELETABLE.indexOf(m.type) !== -1;
            });
            var i = 0;

            function nextDelete() {
              if (stopRequested || i >= mine.length) {
                if (stopRequested || msgs.length < 100) return finish();
                return nextPage();
              }
              var m = mine[i++];
              api("del", "/channels/" + channelId + "/messages/" + m.id)
                .then(function () { deleted++; }, function () { failed++; })
                .then(function () {
                  if (onProgress) onProgress(deleted, failed);
                  return sleep(350);
                })
                .then(nextDelete);
            }
            nextDelete();
          })
          .catch(fail);
      }

      nextPage();
    });
  }

  // Settings page built only from react-native primitives
  function Settings() {
    var React = R();
    var RN = RNm();
    var cs = React.useState("");
    var channelId = cs[0], setChannelId = cs[1];
    var ss = React.useState("Idle");
    var status = ss[0], setStatus = ss[1];
    var h = React.createElement;

    function button(label, onPress, color) {
      return h(
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
    }

    function start() {
      var id = channelId.trim();
      RN.Alert.alert(
        "Delete all your messages?",
        "This permanently deletes every message you sent in channel " + id + ". It cannot be undone.",
        [
          { text: "Cancel", style: "cancel" },
          {
            text: "Delete",
            style: "destructive",
            onPress: function () {
              setStatus("Starting...");
              purge(id, function (d, f) {
                setStatus("Deleted " + d + (f ? ", failed " + f : ""));
              }).then(
                function (r) {
                  setStatus(
                    (r.stopped ? "Stopped" : "Done") + ": deleted " + r.deleted +
                      (r.failed ? ", failed " + r.failed : "")
                  );
                },
                function (e) {
                  setStatus("Error: " + (e && e.message ? e.message : e));
                }
              );
            },
          },
        ]
      );
    }

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
      button("Stop", function () { stopRequested = true; }, "#4e5058"),
      h(RN.Text, { style: { color: "#ccc", marginTop: 16 } }, status)
    );
  }

  return {
    onLoad: function () {
      try {
        var reg = v.commands && v.commands.registerCommand;
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
              var id = String(args[0].value).trim();
              toast("DM Purge started", "Check");
              purge(id).then(
                function (r) {
                  toast(
                    "Deleted " + r.deleted + " message(s)" +
                      (r.failed ? ", " + r.failed + " failed" : ""),
                    "Check"
                  );
                },
                function (e) {
                  toast("DM Purge: " + (e && e.message ? e.message : e), "Small");
                }
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
      unregister.forEach(function (u) { try { u(); } catch (e) {} });
      unregister.length = 0;
    },
    settings: Settings,
  };
})()
