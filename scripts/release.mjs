// Builds everything that needs to be hosted for `curl ... | sh`:
//   release/install.sh
//   release/latest                        version, file name and sha256 of the tarball
//   release/sunlight-cli-<version>.tgz
// Copy the folder's contents to <BASE_URL> (default https://meteorcli.yavqo.com/).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";

const { version } = JSON.parse(readFileSync("package.json", "utf8"));
const out = "release";

rmSync(out, { recursive: true, force: true });
mkdirSync(out);
execFileSync("npx", ["tsc"], { stdio: "inherit" });
execFileSync("npm", ["pack", "--pack-destination", out, "--silent"], { stdio: "inherit" });

const file = readdirSync(out).find((f) => f.endsWith(".tgz"));
if (file !== `sunlight-cli-${version}.tgz`) throw new Error(`Unexpected tarball name: ${file}`);
const sha256 = createHash("sha256").update(readFileSync(`${out}/${file}`)).digest("hex");

writeFileSync(`${out}/latest`, `version=${version}\nfile=${file}\nsha256=${sha256}\n`);
copyFileSync("scripts/install.sh", `${out}/install.sh`);
console.log(`\nBuilt Sunlight CLI ${version} in ${out}/\n  ${file}\n  sha256 ${sha256}`);
