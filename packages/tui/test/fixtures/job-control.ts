import { Editor, TUI } from "../../src/index";
import { ProcessTerminal, setAltScreenActive } from "../../src/terminal";
import { defaultEditorTheme } from "../test-themes";

const report = process.argv[2]!;
const overlay = process.argv[3] === "overlay";
const terminal = new ProcessTerminal();
const tui = new TUI(terminal);
const editor = new Editor(defaultEditorTheme);
editor.setText("abc");
editor.handleInput("\x01");
editor.onChange = text => {
	void Bun.write(`${report}.text`, text);
};
tui.addChild(editor);
tui.setFocus(editor);
tui.start();
terminal.write("\x1b[?5522h");
if (overlay) {
	terminal.write("\x1b[?1049h\x1b[?1000h\x1b[?1006h");
	setAltScreenActive(true);
}
await Bun.write(report, String(process.pid));
// Keep a background-start probe alive even before stdin is attached.
setInterval(() => {}, 1000);
