import assert from "node:assert/strict";
import { avatarSvg } from "../src/account-avatar.js";

const id = "550e8400-e29b-41d4-a716-446655440000";
const original = avatarSvg(id);
assert.equal(avatarSvg(id), original, "same ID must generate the same avatar");
// Renaming a record does not affect the ID-only API.
const account = { id, name: "Old name" };
const beforeRename = avatarSvg(account.id);
account.name = "New name";
assert.equal(avatarSvg(account.id), beforeRename);

const examples = Array.from({ length: 300 }, (_, i) =>
  `550e8400-e29b-41d4-a716-${i.toString(16).padStart(12, "0")}`
);
const icons = examples.map(avatarSvg);
assert.equal(new Set(icons).size, examples.length, "sample IDs should produce distinct icons");
assert.equal(avatarSvg(id), original, "eviction must not change generated output");

const hostile = `</svg><script>alert('x')</script><svg onload="alert(1)">`;
for (const svg of [...icons, avatarSvg(hostile)]) {
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="48" height="48" viewBox="0 0 48 48">/);
  assert.match(svg, /<\/svg>$/);
  assert.ok(svg.length < 10000, "SVG size is bounded for representative inputs");
  assert.doesNotMatch(svg, /<script|onload|<foreignObject|href=|alert\(/i);
  assert.match(svg, /<path fill="#[0-9a-f]{6}" d="[^"]+"\/>/i);
}
assert.throws(() => avatarSvg(""), TypeError);
assert.throws(() => avatarSvg({ id }), TypeError);
console.log(`Account avatars: ${examples.length} distinct sample IDs; stability and injection checks passed.`);
