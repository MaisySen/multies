/**
 * MFIX1 (1.10.16): the What's new words for 1.10.16 in English, Nepali and Hindi. The sheet shows these for its
 * version when they exist (key m.wn.<version>.<item>.title and .body), else the English from CHANGELOG.md.
 */
import type { Bundle } from "./core";

export const mfix1En: Bundle = {
  "m.wn.heading": "What's new",
  "m.wn.continue": "Continue",
  "m.wn.1.10.16.0.title": "Meetings open in your phone's browser",
  "m.wn.1.10.16.0.body": "Joining a meeting opens Safari or Chrome, already signed in, so a recording saves and shares properly instead of waiting on Saving the video. Meeting notes on the web open there too.",
};

export const mfix1Ne: Bundle = {
  "m.wn.heading": "नयाँ के छ",
  "m.wn.continue": "जारी राख्नुहोस्",
  "m.wn.1.10.16.0.title": "बैठक तपाईंको फोनको ब्राउजरमा खुल्छ",
  "m.wn.1.10.16.0.body": "बैठकमा जोडिँदा Safari वा Chrome खुल्छ, साइन इन भइसकेको, त्यसैले रेकर्डिङ भिडियो सेभ गर्दै मा अड्किँदैन, ठीकसँग सेभ र सेयर हुन्छ। वेबका बैठक नोट पनि त्यहीँ खुल्छन्।",
};

export const mfix1Hi: Bundle = {
  "m.wn.heading": "नया क्या है",
  "m.wn.continue": "जारी रखें",
  "m.wn.1.10.16.0.title": "मीटिंग आपके फ़ोन के ब्राउज़र में खुलती है",
  "m.wn.1.10.16.0.body": "मीटिंग में जुड़ने पर Safari या Chrome खुलता है, पहले से साइन इन, ताकि रिकॉर्डिंग वीडियो सेव हो रहा है पर अटके बिना ठीक से सेव और शेयर हो। वेब पर मीटिंग नोट्स भी वहीं खुलते हैं।",
};
