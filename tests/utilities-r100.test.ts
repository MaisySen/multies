import { describe, expect, it } from "vitest";
import {
  base64ToUtf8, contrast, convertData, convertUnit, colourFormats, diffLines, diffStats, hash, jsonErrorAt, md5, minifyJson,
  parseColour, parseData, parseTime, replaceRegex, testRegex, tidy, timeFormats, utf8ToBase64, uuidInfo, uuidV4, uuidV7,
} from "../src/shared/utilities";

const enc = (s: string) => new TextEncoder().encode(s);

describe("R100 utilities: data formats", () => {
  it("formats and converts JSON, YAML and CSV", () => {
    expect(convertData('{"a":1,"b":[1,2]}', "json", "json")).toBe('{\n  "a": 1,\n  "b": [\n    1,\n    2\n  ]\n}');
    expect(convertData('{"a":1}', "json", "yaml")).toBe("a: 1");
    expect(convertData("a: 1\nb: two", "yaml", "json", 0)).toBe('{"a":1,"b":"two"}');
    expect(convertData('[{"n":"A","x":1},{"n":"B,C","y":true}]', "json", "csv")).toBe('n,x,y\r\nA,1,\r\n"B,C",,true');
    expect(convertData("n,x\nA,1\nB,2", "csv", "json", 0)).toBe('[{"n":"A","x":"1"},{"n":"B","x":"2"}]');
    expect(minifyJson('{ "a" : [ 1 , 2 ] }')).toBe('{"a":[1,2]}');
  });
  it("says where JSON is broken, in plain words", () => {
    expect(() => parseData('{"a":1,}', "json")).toThrow(/not valid JSON/);
    expect(jsonErrorAt('{\n"a":x}', new Error("Unexpected token x at position 6"))).toEqual({ line: 2, col: 5 });
    expect(() => parseData("", "json")).toThrow("Paste or type something first.");
    expect(() => parseData("a: [1", "yaml")).toThrow(/not valid YAML/);
  });
  it("refuses shapes CSV cannot hold and YAML alias bombs", () => {
    expect(() => convertData("[1,2]", "json", "csv")).toThrow(/Row 1/);
    expect(() => convertData('"x"', "json", "csv")).toThrow(/list of rows/);
    const bomb = "a: &a [x,x,x,x,x,x,x,x,x]\n" + Array.from({ length: 8 }, (_, i) => `${String.fromCharCode(98 + i)}: &${String.fromCharCode(98 + i)} [${Array(9).fill("*" + String.fromCharCode(97 + i)).join(",")}]`).join("\n");
    expect(() => parseData(bomb, "yaml")).toThrow(/not valid YAML/);
  });
});

describe("R100 utilities: Base64, hash, UUID", () => {
  it("round trips any text, URL safe too", () => {
    expect(utf8ToBase64("नमस्ते ✓")).toBe("4KSo4KSu4KS44KWN4KSk4KWHIOKckw==");
    expect(base64ToUtf8("4KSo4KSu4KS44KWN4KSk4KWHIOKckw==")).toBe("नमस्ते ✓");
    expect(utf8ToBase64("??>", true)).toBe("Pz8-");
    expect(base64ToUtf8("Pz8-")).toBe("??>");
    expect(base64ToUtf8("aGk")).toBe("hi");
  });
  it("explains bad Base64", () => {
    expect(() => base64ToUtf8("a$b")).toThrow(/not Base64/);
    expect(() => base64ToUtf8("abcde")).toThrow(/cut short/);
    expect(() => base64ToUtf8("/w==")).toThrow(/file, not text/);
    expect(() => base64ToUtf8("  ")).toThrow(/Paste some/);
  });
  it("hashes like the standard test vectors", async () => {
    expect(md5(enc(""))).toBe("d41d8cd98f00b204e9800998ecf8427e");
    expect(md5(enc("The quick brown fox jumps over the lazy dog"))).toBe("9e107d9d372bb6826bd81d3542a419d6");
    expect(md5(enc("a".repeat(1000)))).toBe("cabe45dcc9ae5b66ba86600cca6b8ba8");
    expect(await hash("SHA-256", "abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(await hash("SHA-1", "abc")).toBe("a9993e364706816aba3e25717850c26c9cd0d89d");
  });
  it("makes v4 and v7 ids and reads them back", () => {
    const v4 = uuidV4();
    expect(v4).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    const t = Date.UTC(2026, 10, 1, 1, 2, 3);
    const v7 = uuidV7(t);
    expect(uuidInfo(v7)).toEqual({ version: 7, time: new Date(t) });
    expect(uuidV7(t + 1) > uuidV7(t, () => new Uint8Array(16).fill(255))).toBe(true);
    expect(() => uuidInfo("nope")).toThrow("This is not a UUID.");
  });
});

describe("R100 utilities: colour, units, time", () => {
  it("reads hex, rgb, hsl and names", () => {
    expect(parseColour("#1a73e8")).toEqual({ r: 26, g: 115, b: 232, a: 1 });
    expect(parseColour("fff")).toEqual({ r: 255, g: 255, b: 255, a: 1 });
    expect(parseColour("rgb(26 115 232 / 50%)")).toEqual({ r: 26, g: 115, b: 232, a: 0.5 });
    expect(parseColour("hsl(0, 100%, 50%)")).toMatchObject({ r: 255, g: 0, b: 0 });
    expect(parseColour("teal")).toMatchObject({ r: 0, g: 128, b: 128 });
    expect(colourFormats(parseColour("#ff000080")).hex).toBe("#ff000080");
    expect(colourFormats(parseColour("#1a73e8"))).toEqual({ hex: "#1a73e8", rgb: "rgb(26, 115, 232)", hsl: "hsl(214, 82%, 51%)" });
    expect(() => parseColour("blurple")).toThrow(/not understood/);
    expect(contrast(parseColour("#000"), parseColour("#fff"))).toBe(21);
  });
  it("converts units with offsets and refuses below absolute zero", () => {
    expect(tidy(convertUnit(100, "temperature", "c", "f"))).toBe("212");
    expect(tidy(convertUnit(0, "temperature", "k", "c"))).toBe("-273.15");
    expect(tidy(convertUnit(1, "length", "mi", "km"))).toBe("1.609344");
    expect(tidy(convertUnit(1, "data", "gib", "mb"))).toBe("1073.741824");
    expect(() => convertUnit(-300, "temperature", "c", "k")).toThrow(/absolute zero/);
    expect(() => convertUnit(NaN, "length", "m", "km")).toThrow("Type a number.");
  });
  it("reads seconds, milliseconds and dates", () => {
    expect(parseTime("1761955200").toISOString()).toBe("2025-11-01T00:00:00.000Z");
    expect(parseTime("1761955200000").toISOString()).toBe("2025-11-01T00:00:00.000Z");
    expect(parseTime("2026-11-01T00:00:00Z").getTime()).toBe(Date.UTC(2026, 10, 1));
    expect(timeFormats(new Date(0), "UTC")).toMatchObject({ unix: "0", ms: "0", iso: "1970-01-01T00:00:00.000Z" });
    expect(() => parseTime("next tuesdayish")).toThrow(/not understood/);
  });
});

describe("R100 utilities: diff and regex", () => {
  it("diffs lines with options", () => {
    const d = diffLines("a\nb\nc\nd", "a\nB\nc\nd\ne");
    expect(d.map((x) => `${x.kind[0]}${x.text}`)).toEqual(["sa", "db", "aB", "sc", "sd", "ae"]);
    expect(diffStats(d)).toEqual({ added: 2, removed: 1 });
    expect(diffStats(diffLines("A  b", "a b", { ignoreCase: true, ignoreSpace: true }))).toEqual({ added: 0, removed: 0 });
    expect(() => diffLines("x\n".repeat(6000), "")).toThrow(/up to 5,000 lines/);
  });
  it("finds matches, groups and explains a broken pattern", () => {
    const r = testRegex("(?<user>\\w+)@(\\w+)\\.com", "g", "ann@site.com, bo@x.com");
    expect(r.matches.map((m) => m.text)).toEqual(["ann@site.com", "bo@x.com"]);
    expect(r.matches[0].named).toEqual({ user: "ann" });
    expect(testRegex("a", "", "aaa").matches).toHaveLength(1);
    expect(testRegex("x*", "g", "ab").matches.length).toBe(3);
    expect(() => testRegex("(", "g", "")).toThrow(/pattern has a mistake/);
    expect(() => testRegex("a", "gg", "")).toThrow(/once each/);
    expect(replaceRegex("(\\d+)", "g", "a1 b22", "<$1>")).toBe("a<1> b<22>");
  });
});
