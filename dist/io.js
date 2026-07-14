"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.readStdin = readStdin;
exports.writeTextOutput = writeTextOutput;
exports.timestampForFile = timestampForFile;
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const errors_1 = require("./errors");
function readStdin(stream = process.stdin) {
    if (stream.isTTY) {
        return Promise.resolve("");
    }
    return new Promise((resolve, reject) => {
        let data = "";
        stream.setEncoding("utf8");
        stream.on("data", (chunk) => {
            data += chunk;
        });
        stream.on("end", () => resolve(data));
        stream.on("error", reject);
    });
}
async function writeTextOutput(text, options = {}) {
    if (!options.output) {
        const stdout = options.stdout || process.stdout;
        stdout.write(text.endsWith("\n") ? text : `${text}\n`);
        return undefined;
    }
    const outputPath = node_path_1.default.resolve(options.output);
    if (node_fs_1.default.existsSync(outputPath)) {
        throw new errors_1.CliError(`Refusing to overwrite existing output file: ${outputPath}.`);
    }
    await node_fs_1.default.promises.mkdir(node_path_1.default.dirname(outputPath), { recursive: true });
    await node_fs_1.default.promises.writeFile(outputPath, text, "utf8");
    return outputPath;
}
function timestampForFile(date = new Date()) {
    const pad = (value) => String(value).padStart(2, "0");
    return [
        date.getFullYear(),
        pad(date.getMonth() + 1),
        pad(date.getDate()),
        "-",
        pad(date.getHours()),
        pad(date.getMinutes()),
        pad(date.getSeconds())
    ].join("");
}
