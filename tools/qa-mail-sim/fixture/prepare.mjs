import { createHash } from "node:crypto";
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const tree = 'd9c8a54cbdf58e0228711c9e632eb75bd8351a8d'; // exact mobile subtree, verified against GitHub main

const bundle = 'au.fintex.multies.mailsmoke';
const [repoArg, dstArg, ...extra] = process.argv.slice(2);
if (!repoArg || !dstArg || extra.length) {
  console.error('usage: node prepare.mjs VERIFIED_REPO NEW_DISPOSABLE_DIRECTORY');
  process.exit(2);
}
const repo = fs.realpathSync(repoArg);
const dst = path.resolve(fs.realpathSync(path.dirname(path.resolve(dstArg))), path.basename(dstArg));
const git = (...args) => execFileSync('git', ['-C', repo, ...args]);
if (git('rev-parse', 'HEAD:mobile').toString().trim() !== tree) throw new Error('Unverified source tree');
if (dst === repo || dst.startsWith(repo + path.sep) || repo.startsWith(dst + path.sep)) throw new Error('Destination must be outside source checkout');
fs.mkdirSync(dst, { mode: 0o700 }); // No overwriting, even if a prior preparation failed.
const archive = gitArchive();
execFileSync('tar', ['-xf', '-', '-C', dst], { input: archive });
const patch = fileURLToPath(new URL('./mail-body-fix.patch', import.meta.url));
if (createHash('sha256').update(fs.readFileSync(patch)).digest('hex') !== '173d4619c891bd3f8ff2deb06e7c6354c13cc74dd677bde60f3b843b8a6a2e2c') throw new Error('Mail fixes do not match the tested patch');
execFileSync('git', ['apply', '--check', patch], { cwd: dst });
execFileSync('git', ['apply', patch], { cwd: dst });
function gitArchive() {
  return execFileSync('git', ['-C', repo, 'archive', 'HEAD', 'mobile'], { maxBuffer: 64 * 1024 * 1024 });
}
const mobile = path.join(dst, 'mobile');
function edit(relative, fn) {
  const filename = path.join(mobile, relative);
  const source = fs.readFileSync(filename, 'utf8');
  const changed = fn(source);
  if (source === changed) throw new Error('Expected edit did not occur');
  fs.writeFileSync(filename, changed);
}
function replaceOne(source, before, after) {
  if (source.split(before).length !== 2) throw new Error('Fixture anchor mismatch');
  return source.replace(before, after);
}
fs.copyFileSync(fileURLToPath(new URL('./fixture.ts', import.meta.url)), path.join(mobile, 'src/sample/mail-smoke.ts'), fs.constants.COPYFILE_EXCL);
edit('src/sample/fixtures.ts', source => 'import { mailSmokeMessages } from "./mail-smoke";\n' +
  replaceOne(source, 'const messages: Message[] = [\n', 'const messages: Message[] = [\n    ...mailSmokeMessages(now),\n'));
edit('src/sample/transport.ts', source => 'import { detailDelayMs, shouldDelaySmokeDetail } from "./mail-smoke";\n' +
  replaceOne(source, '    if (this.latencyMs)', '    if (shouldDelaySmokeDetail(method, rawPath)) await new Promise((resolve) => setTimeout(resolve, detailDelayMs));\n    if (this.latencyMs)'));
edit('app.json', source => {
  const config = JSON.parse(source);
  const expo = config.expo;
  expo.ios.bundleIdentifier = bundle;
  expo.ios.buildNumber = '2';
  delete expo.ios.associatedDomains;
  expo.ios.infoPlist = { ...expo.ios.infoPlist, CFBundleDisplayName: 'Multies Mail Smoke', MultiesMailSmokeFixtureVersion: '2' };
  expo.scheme = 'multies-mailsmoke';
  expo.updates = { enabled: false, checkAutomatically: 'NEVER' };
  expo.extra = { ...expo.extra, apiBase: 'http://127.0.0.1:9' };
  delete expo.extra.eas;
  return JSON.stringify(config, null, 2) + '\n';
});
// Remove EAS profiles from this throwaway copy; preparation never builds or publishes.
fs.unlinkSync(path.join(mobile, 'eas.json'));
console.log('Fixture v2 prepared from verified source; no build or iOS run.');
