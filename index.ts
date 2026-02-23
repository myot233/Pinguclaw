import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { QQChannel } from "./src/channel";
import { setQQRuntime } from "./src/runtime";
const plugin = {
  id: "pinguclaw",
  name: "PinguClaw",
  description: "a channel plugin via OneBot v11",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    setQQRuntime(api.runtime);
    api.registerChannel({ plugin: QQChannel });
  },
};

export default plugin;
