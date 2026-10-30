import { describe, it, expect } from "vitest";
import { displayFirstName, nameLooksLikeEmail } from "@/shared/display-name";

describe("R41 MB-224: displayFirstName", () => {
  it("uses a real first name", () => {
    expect(displayFirstName("Olive Owner", "olive@example.com")).toBe("Olive");
    expect(displayFirstName("  Sam  ", "s@example.com")).toBe("Sam");
  });
  it("never shows a raw email local part", () => {
    expect(displayFirstName("mymail.builder+qa3p55caab", "mymail.builder+qa3p55caab@mail.example")).toBe("");
    expect(displayFirstName("mymail.builder+qa3p55caab@mail.example", "mymail.builder+qa3p55caab@mail.example")).toBe("");
    expect(displayFirstName("", "info@acme.com")).toBe("");
    expect(displayFirstName("qa3p55", "qa3p55@x.com")).toBe("");
  });
  it("takes a name shaped local part, title cased", () => {
    expect(displayFirstName("olive.owner", "olive.owner@example.com")).toBe("Olive");
    expect(displayFirstName("", "sam+work@example.com")).toBe("Sam");
    expect(displayFirstName("jane99", "jane99@example.com")).toBe("Jane");
  });
  it("knows which names are just the email", () => {
    expect(nameLooksLikeEmail("mymail.builder+qa", "mymail.builder+qa@x.com")).toBe(true);
    expect(nameLooksLikeEmail("Ada Lovelace", "ada@x.com")).toBe(false);
    expect(nameLooksLikeEmail("ada", "ada@x.com")).toBe(true);
    expect(nameLooksLikeEmail("Ada", "ada.l@x.com")).toBe(false);
  });
});
