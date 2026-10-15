// Entry of the legacy build (see vite.legacy.config.ts). The polyfills come first so
// they are in place before sendspin-js runs.
import "./legacy-polyfills";
import "./legacy-chunk-merger";
import "./legacy-diagnostics";
import "./legacy-headless";
import { useLegacyDeviceSettings } from "./main";

useLegacyDeviceSettings();
