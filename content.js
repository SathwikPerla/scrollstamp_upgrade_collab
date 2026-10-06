// ScrollStamp v2.2 — Unified bookmarking extension

(function () {
  "use strict";

  // Prevent double-injection: manifest content_scripts + background.js onInstalled
  // both inject this file; without this guard, all listeners fire twice.
  if (window.__scrollstampLoaded) return;
  window.__scrollstampLoaded = true;

  // ============================================
  // PLATFORM DETECTION
  // ============================================

  const AI_PLATFORM_SELECTORS = {
    chatgpt: {
      assistant: '[data-message-author-role="assistant"]',
      messageText: ".markdown",
    },
    claude: {
      assistant: '[data-testid="assistant-message"], .font-claude-message',
      messageText: ".prose",
    },
    gemini: {
      assistant: '[data-message-author="1"], .model-response-text',
      messageText: ".message-content",
    },
    perplexity: {
      assistant: '[data-testid="answer-content"], .prose',
      messageText: ".prose",
    },
    grok: {
      assistant: '[data-testid="assistant-message"]',
      messageText: ".message-content",
    },
    deepseek: {
      assistant: ".ds-markdown",
      messageText: ".ds-markdown",
    },
  };

  function detectAIPlatform() {
    const host = window.location.hostname;
    if (host.includes("chatgpt") || host.includes("chat.openai")) return "chatgpt";
    if (host.includes("claude")) return "claude";
    if (host.includes("gemini")) return "gemini";
    if (host.includes("perplexity")) return "perplexity";
    if (host.includes("grok")) return "grok";
    if (host.includes("deepseek")) return "deepseek";
    return null;
  }

  function isPDFPage() {
    const url = window.location.href.toLowerCase();
    const contentType = document.contentType || "";
    return (
      url.endsWith(".pdf") ||
      contentType.includes("pdf") ||
      document.querySelector('embed[type="application/pdf"]') !== null ||
      document.body?.children[0]?.tagName === "EMBED"
    );
  }

  let selectionBtn = null;
  let hasActiveSelection = false;
  let currentPlatform = null;
  let isAIChat = false;
  let isPDF = false;
  let isReadingPage = false;
  let listenersAttached = false;
  let isSiteDisabled = false;

  // Hostnames the user has explicitly switched ScrollStamp OFF for, overriding
  // whatever the automatic default would be (an LLM platform, a detected
  // reading page, anything).
  const DISABLED_SITES_KEY = "scrollstamp_disabled_sites";
  // Hostnames the user has explicitly switched ScrollStamp ON for. Symmetric
  // to the list above: the automatic reading-page/app-host detection below is
  // a heuristic and will occasionally misjudge a site, so every automatic
  // decision must stay reversible in both directions from the popup toggle,
  // never just one.
  const ENABLED_SITES_KEY = "scrollstamp_enabled_sites";

  // ============================================
  // SITE ELIGIBILITY (auto-detect where ScrollStamp is welcome)
  // ============================================
  //
  // The selection-bookmark button used to appear on every page by default,
  // which is what made it feel intrusive on interactive apps (Gmail, Figma —
  // reported directly by users). The new default: ON for AI chat platforms
  // (unchanged) and for pages that look like long-form reading material
  // (docs, wikis, articles, blogs — the actual use case for bookmarking a
  // reading position); OFF for everything else, including known interactive
  // apps and plain short pages, unless the user explicitly turns it on for
  // that site.

  // Exact-hostname matches only — zero false-positive risk, unlike judging a
  // page's DOM shape. This is the strong signal for "definitely an app," and
  // it is checked before the softer heuristic below so it always wins.
  const KNOWN_APP_HOSTS = [
    "mail.google.com", "docs.google.com", "sheets.google.com", "slides.google.com",
    "drive.google.com", "calendar.google.com", "photos.google.com",
    "figma.com", "notion.so", "slack.com", "app.slack.com",
    "trello.com", "asana.com", "app.asana.com", "linear.app",
    "twitter.com", "x.com", "facebook.com", "instagram.com", "linkedin.com",
    "canva.com", "airtable.com", "miro.com", "discord.com", "web.whatsapp.com",
  ];

  function isKnownAppHost() {
    const host = window.location.hostname.replace(/^www\./, "");
    return KNOWN_APP_HOSTS.includes(host);
  }

  // Soft heuristic for hosts that are neither an AI platform nor a known app:
  // does this page look like something you'd scroll through and read, rather
  // than a tool you click around in? Two independent signals must both agree:
  // (1) genuinely long — the user's own description was "a long page you
  // scroll through to find your spot again," which is a page-height signal,
  // not a text-amount signal alone; (2) that length is mostly plain reading
  // content, not a dense mesh of interactive controls (a form-heavy page can
  // also be tall). Failing either means the automatic default stays OFF —
  // the instruction was for the unclassified fallback to be off, not on.
  function looksLikeReadingPage() {
    try {
      const scrollable = document.documentElement.scrollHeight - window.innerHeight;
      if (scrollable < window.innerHeight * 1.5) return false;

      const textEls = document.querySelectorAll(
        "p, article, li, h1, h2, h3, h4, h5, h6, blockquote, pre, td, dd, dt"
      );
      let textLen = 0;
      textEls.forEach((el) => { textLen += (el.textContent || "").length; });
      if (textLen < 800) return false;

      const interactiveEls = document.querySelectorAll(
        "input, textarea, select, button, [contenteditable], canvas, [role='application']"
      );
      // A handful of controls (search box, nav, cookie banner) is normal on an
      // article; a page dominated by them is a tool, not something you read.
      if (interactiveEls.length > 40) return false;

      return true;
    } catch {
      return false; // a heuristic failing closed must never block the page itself
    }
  }

  // Everything an explicit per-site toggle can override. Computed once per
  // page load — good enough for the server-rendered documentation/wiki/blog
  // sites this targets, which have their content present well before this
  // runs; not re-checked as a page grows, which is a known limitation for a
  // heavily client-rendered page that starts short and grows long.
  function isSiteActiveByDefault() {
    return isAIChat || (!isKnownAppHost() && isReadingPage);
  }

  // ============================================
  // AI MESSAGE BOOKMARKING
  // ============================================

  // Re-reading the whole conversation is not free on a long chat, and the
  // Claude/Grok fallback below forces a layout for every candidate it inspects.
  // The hunt asks for this list twice per cycle, so a very short memo removes the
  // duplicate read. The window is far shorter than any polling interval, so no
  // caller can observe a meaningfully stale list.
  let messagesMemo = { at: 0, list: null };

  function getAssistantMessages() {
    if (!currentPlatform || !AI_PLATFORM_SELECTORS[currentPlatform]) return [];

    const now = Date.now();
    if (messagesMemo.list && now - messagesMemo.at < 40) return messagesMemo.list;

    const selector = AI_PLATFORM_SELECTORS[currentPlatform].assistant;
    let messages = Array.from(document.querySelectorAll(selector));

    // Fallback tree-walk for Claude/Grok when strict selectors return nothing
    if (messages.length === 0 && (currentPlatform === "claude" || currentPlatform === "grok")) {
      const fallbackSelectors = [
        "article",
        "div[data-testid*='conversation']",
        "div[data-testid*='message']",
        'div[class*="message"]',
        'div[class*="response"]',
        'div[class*="assistant"]',
        'div[class*="answer"]',
      ];
      const candidates = new Set();
      for (const sel of fallbackSelectors) {
        document.querySelectorAll(sel).forEach((el) => candidates.add(el));
      }
      messages = Array.from(candidates).filter((el) => {
        const deepNode = el.querySelector(".prose, .markdown, [class*='content'], [class*='text']");
        const text = ((deepNode || el).textContent || "").trim();
        if (text.length < 30) return false;
        const rect = el.getBoundingClientRect();
        return rect.height > 20 && rect.width > 50;
      });
    }

    messagesMemo = { at: now, list: messages };
    return messages;
  }

  function findNearestAssistantMessage() {
    const messages = getAssistantMessages();
    if (messages.length === 0) return null;

    const viewportCenter = window.innerHeight / 2;
    let nearest = null;
    let minDistance = Infinity;

    messages.forEach((msg, index) => {
      const rect = msg.getBoundingClientRect();
      if (rect.top < window.innerHeight && rect.bottom > 0) {
        const distance = Math.abs(rect.top + rect.height / 2 - viewportCenter);
        if (distance < minDistance) { minDistance = distance; nearest = { element: msg, index }; }
      }
    });

    if (!nearest) {
      messages.forEach((msg, index) => {
        const distance = Math.abs(msg.getBoundingClientRect().top);
        if (distance < minDistance) { minDistance = distance; nearest = { element: msg, index }; }
      });
    }

    return nearest;
  }

  function getMessagePreview(element) {
    const textSelector = AI_PLATFORM_SELECTORS[currentPlatform]?.messageText;
    const textEl = textSelector ? element.querySelector(textSelector) : element;
    return ((textEl || element).textContent || "").trim().substring(0, 100).replace(/\s+/g, " ");
  }

  function generateMessageId(element, index) {
    const preview = getMessagePreview(element);
    let hash = 0;
    for (let i = 0; i < preview.length; i++) {
      hash = (hash << 5) - hash + preview.charCodeAt(i);
      hash = hash & hash;
    }
    return `msg_${index}_${Math.abs(hash).toString(36)}`;
  }

  // Walk up to find the nearest scrollable container (AI SPAs scroll an inner div, not window).
  function findScrollContainer(element) {
    let el = element?.parentElement;
    while (el && el !== document.documentElement) {
      const { overflowY } = window.getComputedStyle(el);
      if ((overflowY === "scroll" || overflowY === "auto") && el.scrollHeight > el.clientHeight) {
        return el;
      }
      el = el.parentElement;
    }
    return null;
  }

  // Best-effort handle on the main chat scroll container, even when we have no
  // target element yet (used by the render-then-research fallback).
  function findMainScrollContainer() {
    const messages = getAssistantMessages();
    for (const msg of messages) {
      const c = findScrollContainer(msg);
      if (c) return c;
    }
    return null;
  }

  // Snapshot the scroll container position at bookmark time. Saved as both an
  // absolute offset and a ratio so a far jump can force lazy content to render
  // even if the page height has since changed.
  function captureContainerAnchor(element) {
    const container = element ? findScrollContainer(element) : findMainScrollContainer();
    if (!container) return {};
    const maxScroll = Math.max(0, container.scrollHeight - container.clientHeight);
    return {
      containerScrollY: container.scrollTop,
      containerScrollRatio: maxScroll > 0 ? container.scrollTop / maxScroll : 0,
    };
  }

  // One glide, not a chase.
  //
  // FIND → STABILIZE → ONE SMOOTH GLIDE → VERIFY → silent correction only if
  // needed → VERIFY → DONE. The glide is the only visible movement; corrections
  // are instant, tiny, and capped, so there is no visible chase and no endless
  // loop. The target is re-resolved from the live DOM at every step — no rect
  // measured earlier in the navigation is ever reused, because content identity
  // decides *what* to land on and only current geometry decides *where*.
  //
  // Any later navigation bumps this token, which every scheduled step checks,
  // so two arrivals can never fight over the scroll position. A real user
  // gesture bumps it too: with a tight landing tolerance, a late correction
  // would otherwise yank the view back out of the user's hands.
  let arrivalToken = 0;
  // The in-flight arrival's own cleanup, so a supersede can run it immediately
  // instead of waiting on that arrival's own (now-dead) callbacks to notice —
  // they check the token and return early without detaching, which is how a
  // superseded arrival's gesture listeners kept accumulating on `window`.
  let activeArrivalDetach = null;

  function cancelArrival() {
    arrivalToken++;
    if (activeArrivalDetach) { activeArrivalDetach(); activeArrivalDetach = null; }
  }

  function arriveSmoothly(resolveTarget, desiredTop, onDone) {
    const t = resolveTarget();
    if (!t) return;

    const container = t.container || null;
    const currentScrollTop = container ? container.scrollTop : window.scrollY;
    const targetScrollTop = Math.max(0, currentScrollTop + (t.rect.top - desiredTop));

    if (container) {
      container.scrollTo({ top: targetScrollTop, behavior: "smooth" });
    } else {
      window.scrollTo({ top: targetScrollTop, behavior: "smooth" });
    }

    if (onDone) {
      setTimeout(() => {
        const freshT = resolveTarget();
        onDone(freshT || t);
      }, 350);
    }
  }

  // Highlight whatever the converger arrived at (a text range or a whole message).
  function highlightArrival(t) {
    if (!t) return;
    if (t.kind === "range" && t.range) {
      highlightRange(t.range);
    } else if (t.element) {
      t.element.classList.add("scrollstamp-highlight");
      setTimeout(() => t.element.classList.remove("scrollstamp-highlight"), 2000);
    }
  }

  // Among candidate positions, the one closest to where the message sat when it
  // was bookmarked. Used only to break ties, never to identify on its own.
  function pickNearest(candidates, index) {
    if (typeof index !== "number" || index < 0) return candidates[0];
    let best = candidates[0];
    let bestDistance = Math.abs(best - index);
    for (const c of candidates) {
      const distance = Math.abs(c - index);
      if (distance < bestDistance) { bestDistance = distance; best = c; }
    }
    return best;
  }

  // Resolve a saved assistant message back to a live DOM element.
  //
  // Matching is by content, with the stored index used only as a tie-breaker.
  // That ordering matters: paging older messages in shifts every index, so an
  // index-first lookup silently drifts onto the wrong message. Text does not
  // shift. The stored preview is compared at full length (100 chars) before any
  // shorter prefix is tried, because assistant replies routinely share an
  // opening phrase and a 30-char prefix is not distinctive enough to pick
  function getAllChatMessages() {
    if (!currentPlatform) return [];
    const sel = AI_PLATFORM_SELECTORS[currentPlatform];
    const baseSelector = sel ? sel.assistant : "";
    const fullSelector = baseSelector
      ? `${baseSelector}, [data-message-author-role], article, div[data-testid*="message"], div[data-testid*="conversation"]`
      : 'article, [data-message-author-role], div[data-testid*="message"]';

    const candidates = Array.from(document.querySelectorAll(fullSelector));
    return candidates.filter((el, idx, arr) => {
      const text = (el.textContent || "").trim();
      if (text.length < 5) return false;
      return !arr.some((other, oIdx) => oIdx !== idx && other.contains(el) && other !== el);
    });
  }

  function previewMatchesAnchor(preview, anchor) {
    if (!preview || !anchor) return false;
    const p = preview.toLowerCase().replace(/\s+/g, " ").trim();
    const a = anchor.toLowerCase().replace(/\s+/g, " ").trim();
    if (p === a || p.startsWith(a) || a.startsWith(p)) return true;
    if (p.includes(a) || a.includes(p)) return true;
    return p.length >= 20 && a.length >= 20 && p.substring(0, 25) === a.substring(0, 25);
  }

  // Remembers the element resolved last, so the repeated re-resolves during a
  // scroll do not re-read every message in the conversation.
  let lastMessageMatch = null;

  function findMessageElement(anchorPreview, index) {
    const messages = getAllChatMessages();
    if (messages.length === 0) return null;

    const anchor = (anchorPreview || "").trim();
    if (!anchor) {
      return typeof index === "number" && index >= 0 && index < messages.length
        ? messages[index]
        : null;
    }

    const remember = (element) => {
      if (element) lastMessageMatch = { anchor, index, element };
      return element;
    };

    const cached = lastMessageMatch;
    if (cached && cached.anchor === anchor && cached.index === index && cached.element.isConnected) {
      if (previewMatchesAnchor(getMessagePreview(cached.element), anchor)) return cached.element;
    }

    if (typeof index === "number" && index >= 0 && index < messages.length) {
      if (previewMatchesAnchor(getMessagePreview(messages[index]), anchor)) {
        return remember(messages[index]);
      }
    }

    const previews = messages.map(getMessagePreview);
    const collect = (test) => {
      const hits = [];
      previews.forEach((p, i) => { if (test(p)) hits.push(i); });
      return hits;
    };

    let hits = collect((p) => p.toLowerCase().trim() === anchor.toLowerCase().trim());
    if (hits.length) return remember(messages[pickNearest(hits, index)]);

    hits = collect((p) => previewMatchesAnchor(p, anchor));
    if (hits.length) return remember(messages[pickNearest(hits, index)]);

    for (const width of [40, 30, 20]) {
      const shortAnchor = anchor.substring(0, width).toLowerCase().trim();
      if (shortAnchor.length < 10) continue;
      hits = collect((p) => p.toLowerCase().trim().startsWith(shortAnchor));
      if (hits.length) return remember(messages[pickNearest(hits, index)]);
    }

    const normAnchor = anchor.toLowerCase().replace(/\s+/g, " ").trim();
    hits = [];
    messages.forEach((m, i) => {
      const txt = (m.textContent || "").toLowerCase().replace(/\s+/g, " ");
      if (txt.includes(normAnchor)) hits.push(i);
    });
    if (hits.length) return remember(messages[pickNearest(hits, index)]);

    return null;
  }

  // ============================================
  // TARGET HUNT (one click, however long it takes)
  // ============================================

  // A bookmarked message usually is not in the DOM when the jump begins: chats
  // page older messages in on demand, or virtualize the list so only the visible
  // window exists. The hunt keeps driving the container until the target really
  // appears, so one click is enough however far back the message sits.
  //
  // The previous implementation gave up after about 5.6 seconds, or sooner once
  // the scroll position stopped moving, which is what forced the click-again-and
  // -again behaviour: each click loaded one more page and then stopped. Two
  // things changed. It now stops only when the container has genuinely stopped
  // growing, meaning the start of the conversation has been reached; and it stops
  // trusting the saved scroll ratio, which was measured against the page height
  // at bookmark time and points somewhere else entirely once pagination has
  // changed that height.
  //
  // GROW walks the view up to make the platform paginate, probing after each
  // step. SEEK then covers virtualized lists, where the height was full size all
  // along and nothing grows.
  let activeHunt = null;

  function cancelHunt(reason) {
    if (!activeHunt) return;
    const hunt = activeHunt;
    activeHunt = null;
    clearTimeout(hunt.timer);
    hunt.detach();
    // A persistent toast belongs to the hunt that showed it; when that hunt dies
    // for any reason, the toast must leave with it or it lingers forever.
    if (reason === "user" || hunt.toastShown) hideToast();
  }

  function huntForTarget(stamp, resolve, desiredTop) {
    cancelHunt("superseded");

    const hunt = { timer: null, toastShown: false, observer: null, detach: () => {} };
    activeHunt = hunt;

    const container = findMainScrollContainer();
    if (!container) {
      if (typeof stamp.scrollY === "number" && stamp.scrollY > 0) {
        window.scrollTo({ top: stamp.scrollY, behavior: "smooth" });
      }
      return true;
    }

    const maxScroll = Math.max(0, container.scrollHeight - container.clientHeight);

    // 1. Direct Instant Jump to saved ratio or offset
    if (typeof stamp.containerScrollRatio === "number") {
      container.scrollTop = stamp.containerScrollRatio * maxScroll;
    } else if (typeof stamp.containerScrollY === "number") {
      container.scrollTop = Math.min(stamp.containerScrollY, maxScroll);
    }

    // 2. High-speed probes around the target ratio (50ms interval, max 300ms total duration)
    // Probe downward (+delta) first before probing upward (-delta)
    const hintRatio = typeof stamp.containerScrollRatio === "number" ? stamp.containerScrollRatio : 0.5;
    const offsets = [0, 0.04, -0.04, 0.08, -0.08, 0.15, -0.15];
    let probeIndex = 0;

    const probeStep = () => {
      if (activeHunt !== hunt) return;

      const target = resolve(true);
      if (target) {
        activeHunt = null;
        arriveSmoothly(() => resolve(true), desiredTop, highlightArrival);
        return;
      }

      if (probeIndex >= offsets.length) {
        activeHunt = null;
        // Park view at exact saved ratio anchor
        container.scrollTop = hintRatio * maxScroll;
        return;
      }

      const ratio = Math.min(1, Math.max(0, hintRatio + offsets[probeIndex]));
      container.scrollTop = ratio * maxScroll;
      probeIndex++;

      hunt.timer = setTimeout(probeStep, 50);
    };

    // Allow 40ms for the SPA virtualizer/DOM to render around initial scroll position
    hunt.timer = setTimeout(probeStep, 40);
    return true;
  }

  function createMessageStamp(messageInfo) {
    return {
      id: generateMessageId(messageInfo.element, messageInfo.index),
      type: "message",
      index: messageInfo.index,
      preview: getMessagePreview(messageInfo.element),
      title: "",
      timestamp: Date.now(),
      url: window.location.href,
      hostname: window.location.hostname,
      platform: currentPlatform,
      // Coarse scroll-container anchor; lets the restore force lazy content to
      // render when the message isn't in the DOM at jump time.
      ...captureContainerAnchor(messageInfo.element),
    };
  }

  function scrollToMessage(stamp) {
    const desiredTop = 80; // bring the message top near the top of the viewport
    const resolve = () => {
      const el = findMessageElement(stamp.preview, stamp.index);
      if (!el) return null;
      return { rect: el.getBoundingClientRect(), container: findScrollContainer(el), element: el, kind: "message" };
    };

    if (resolve()) {
      arriveSmoothly(resolve, desiredTop, highlightArrival);
      return true;
    }
    return huntForTarget(stamp, resolve, desiredTop);
  }

  // ============================================
  // SELECTION BOOKMARKING (all pages)
  // ============================================

  function getScrollPercentage() {
    if (isPDF) {
      const pdfContainer = document.querySelector("#viewerContainer");
      if (pdfContainer) {
        const sh = pdfContainer.scrollHeight - pdfContainer.clientHeight;
        if (sh > 0) return Math.round((pdfContainer.scrollTop / sh) * 100);
      }
    }
    const scrollTop = window.scrollY || document.documentElement.scrollTop || 0;
    const scrollHeight = document.documentElement.scrollHeight - window.innerHeight;
    return scrollHeight <= 0 ? 0 : Math.round((scrollTop / scrollHeight) * 100);
  }

  function getContextBefore(root, node, offset, maxLen = 60) {
    if (!root || !node) return "";
    try {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let accumulated = "";
      let currentNode;
      const prevNodes = [];
      while ((currentNode = walker.nextNode())) {
        if (currentNode === node) {
          accumulated += (node.textContent || "").substring(0, offset);
          break;
        }
        prevNodes.push(currentNode);
      }
      let result = accumulated;
      for (let i = prevNodes.length - 1; i >= 0 && result.length < maxLen; i--) {
        result = (prevNodes[i].textContent || "") + result;
      }
      return result.slice(-maxLen);
    } catch {
      const txt = node.textContent || "";
      return txt.substring(Math.max(0, offset - maxLen), offset);
    }
  }

  function getContextAfter(root, node, offset, maxLen = 60) {
    if (!root || !node) return "";
    try {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let accumulated = "";
      let currentNode;
      let found = false;
      while ((currentNode = walker.nextNode())) {
        if (currentNode === node) {
          found = true;
          accumulated += (node.textContent || "").substring(offset);
          if (accumulated.length >= maxLen) {
            return accumulated.substring(0, maxLen);
          }
          continue;
        }
        if (found) {
          accumulated += currentNode.textContent || "";
          if (accumulated.length >= maxLen) {
            return accumulated.substring(0, maxLen);
          }
        }
      }
      return accumulated.substring(0, maxLen);
    } catch {
      const txt = node.textContent || "";
      return txt.substring(offset, offset + maxLen);
    }
  }

  // Fast memory index of chat messages to resolve bookmarks with 0 loading delay
  let localChatIndex = { at: 0, items: [] };

  function preIndexChatMessages() {
    if (!isAIChat || !currentPlatform) return [];
    const now = Date.now();
    if (localChatIndex.items.length > 0 && now - localChatIndex.at < 500) {
      return localChatIndex.items;
    }
    const msgs = getAllChatMessages();
    const items = msgs.map((msg, index) => {
      const preview = getMessagePreview(msg);
      const text = (msg.textContent || "").trim();
      const lowerText = text.toLowerCase().replace(/\s+/g, " ");
      const tableEls = Array.from(msg.querySelectorAll("table, pre, code, tr, td"));
      return { msg, index, preview, text, lowerText, tableEls };
    });
    localChatIndex = { at: now, items };
    return items;
  }

  function createSelectionStamp(selectedText, contextBefore, contextAfter, messageEl, messageIndex, charOffset, docCharOffset) {
    return {
      id: `sel_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      type: "selection",
      selectedText,
      contextBefore: contextBefore || "",
      contextAfter: contextAfter || "",
      charOffset,
      docCharOffset,
      messageIndex,
      messagePreview: messageEl ? getMessagePreview(messageEl) : "",
      preview: selectedText.substring(0, 100).replace(/\s+/g, " "),
      title: "",
      timestamp: Date.now(),
      url: window.location.href,
      hostname: window.location.hostname,
      platform: currentPlatform || "web",
      scrollY: window.scrollY,
      scrollPercent: getScrollPercentage(),
      ...captureContainerAnchor(messageEl),
    };
  }

  // Helper to normalize text and build a map of indices
  function getNormalizedTextAndMap(text) {
    let normalized = "";
    const map = []; // map[i] = index in original text
    let isPrevWhitespace = false;

    for (let i = 0; i < text.length; i++) {
      let char = text[i];
      if (char === "\u00a0") char = " ";
      else if (char === "“" || char === "”") char = '"';
      else if (char === "‘" || char === "’") char = "'";
      else if (char === "—" || char === "–") char = "-";

      const isWhitespace = /\s/.test(char);

      if (isWhitespace) {
        if (!isPrevWhitespace && normalized.length > 0) {
          normalized += " ";
          map.push(i);
          isPrevWhitespace = true;
        }
      } else {
        normalized += char.toLowerCase();
        map.push(i);
        isPrevWhitespace = false;
      }
    }
    if (normalized.endsWith(" ")) {
      normalized = normalized.slice(0, -1);
      map.pop();
    }
    return { normalized, map };
  }

  // Raw character offset of (node, offset) within root's concatenated text.
  function textOffsetWithin(root, node, offset) {
    if (!root || !node) return -1;
    try {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let total = 0;
      let n;
      while ((n = walker.nextNode())) {
        if (n === node) return total + offset;
        total += n.textContent.length;
      }
    } catch (_) {}
    return -1;
  }

  // ALL occurrences are collected and the one nearest the saved in-root offset
  // wins. Taking the first bare-text match is how a bookmark on a few common
  // words landed on an earlier repetition of the same phrase instead of the
  // spot the user actually selected.
  function findBestTextRange(root, searchText, contextBefore, contextAfter, preferredOffset) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes = [];
    let fullText = "";
    let node;
    while ((node = walker.nextNode())) {
      nodes.push({ node, start: fullText.length });
      fullText += node.textContent;
    }
    if (!nodes.length) return null;

    const { normalized: normalizedFullText, map: fullToOriginalMap } = getNormalizedTextAndMap(fullText);
    const { normalized: normSearch } = getNormalizedTextAndMap(searchText || "");
    const { normalized: normContextBefore } = getNormalizedTextAndMap(contextBefore || "");
    const { normalized: normContextAfter } = getNormalizedTextAndMap(contextAfter || "");

    if (!normSearch) return null;

    const collectStarts = (needle, shift) => {
      const starts = [];
      let idx = normalizedFullText.indexOf(needle);
      while (idx >= 0 && starts.length < 50) {
        starts.push(idx + shift);
        idx = normalizedFullText.indexOf(needle, idx + 1);
      }
      return starts;
    };

    let candidates = [];
    // Priority 1: contextBefore + searchText + contextAfter
    if (normContextBefore && normContextAfter) {
      const fullCombo = normContextBefore + normSearch + normContextAfter;
      candidates = collectStarts(fullCombo, normContextBefore.length);
      if (!candidates.length && normContextBefore.length > 15 && normContextAfter.length > 15) {
        const shortCombo = normContextBefore.slice(-15) + normSearch + normContextAfter.slice(0, 15);
        candidates = collectStarts(shortCombo, 15);
      }
    }

    // Priority 2: contextBefore + searchText
    if (!candidates.length && normContextBefore) {
      candidates = collectStarts(normContextBefore + normSearch, normContextBefore.length);
      if (!candidates.length && normContextBefore.length > 20) {
        const shortCtx = normContextBefore.slice(-20);
        candidates = collectStarts(shortCtx + normSearch, shortCtx.length);
      }
      if (!candidates.length && normContextBefore.length > 10) {
        const shortCtx = normContextBefore.slice(-10);
        candidates = collectStarts(shortCtx + normSearch, shortCtx.length);
      }
    }

    // Priority 3: searchText + contextAfter
    if (!candidates.length && normContextAfter) {
      candidates = collectStarts(normSearch + normContextAfter, 0);
      if (!candidates.length && normContextAfter.length > 20) {
        const shortCtx = normContextAfter.slice(0, 20);
        candidates = collectStarts(normSearch + shortCtx, 0);
      }
    }

    // Priority 4: Plain searchText
    if (!candidates.length) candidates = collectStarts(normSearch, 0);
    if (!candidates.length) return null;

    let normStart = candidates[0];
    if (typeof preferredOffset === "number" && preferredOffset >= 0 && candidates.length > 1) {
      let bestDist = Infinity;
      for (const c of candidates) {
        const dist = Math.abs(fullToOriginalMap[c] - preferredOffset);
        if (dist < bestDist) { bestDist = dist; normStart = c; }
      }
    }

    const normEnd = normStart + normSearch.length;
    const textStart = fullToOriginalMap[normStart];
    const textEnd = fullToOriginalMap[normEnd - 1] + 1;

    if (textStart === undefined || textEnd === undefined) return null;

    let startNode = null, startOffset = 0, endNode = null, endOffset = 0;

    for (const { node: n, start } of nodes) {
      const end = start + n.textContent.length;
      if (!startNode && textStart >= start && textStart < end) {
        startNode = n;
        startOffset = textStart - start;
      }
      if (!endNode && textEnd > start && textEnd <= end) {
        endNode = n;
        endOffset = textEnd - start;
        break;
      }
    }
    if (!startNode || !endNode) return null;

    try {
      const range = document.createRange();
      range.setStart(startNode, startOffset);
      range.setEnd(endNode, endOffset);
      return range;
    } catch {
      return null;
    }
  }

  function highlightRange(range) {
    if (typeof Highlight !== "undefined" && typeof CSS !== "undefined" && CSS.highlights) {
      try {
        const highlight = new Highlight(range);
        CSS.highlights.set("scrollstamp-custom-highlight", highlight);
        setTimeout(() => {
          CSS.highlights.delete("scrollstamp-custom-highlight");
        }, 2500);
        return;
      } catch (e) {
        console.error("ScrollStamp: CSS Highlight error", e);
      }
    }

    try {
      const mark = document.createElement("mark");
      mark.className = "scrollstamp-text-highlight";
      range.surroundContents(mark);
      setTimeout(() => {
        const parent = mark.parentNode;
        if (parent) {
          while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
          parent.removeChild(mark);
        }
      }, 2500);
    } catch {
      // surroundContents throws when the range spans element boundaries; scroll already worked
    }
  }

  function scrollToSelection(stamp) {
    const desiredTop = 120;
    preIndexChatMessages();

    const resolve = (allowDocumentFallback = false) => {
      const hasMessageAnchor = isAIChat && stamp.messagePreview;
      let messageEl = hasMessageAnchor ? findMessageElement(stamp.messagePreview, stamp.messageIndex) : null;

      if (hasMessageAnchor && !messageEl && stamp.selectedText) {
        const indexed = preIndexChatMessages();
        const normSearch = stamp.selectedText.trim().toLowerCase();
        const normBefore = (stamp.contextBefore || "").trim().toLowerCase();
        const normAfter = (stamp.contextAfter || "").trim().toLowerCase();
        const needle = (normBefore + " " + normSearch + " " + normAfter).trim();

        let hits = [];
        indexed.forEach((item) => {
          if (needle.length > 5 && item.lowerText.includes(needle)) {
            hits.push(item.index);
          } else if (normBefore.length >= 5 && item.lowerText.includes(normBefore) && item.lowerText.includes(normSearch)) {
            hits.push(item.index);
          } else if (normAfter.length >= 5 && item.lowerText.includes(normAfter) && item.lowerText.includes(normSearch)) {
            hits.push(item.index);
          }
        });

        if (hits.length) {
          const bestIdx = pickNearest(hits, stamp.messageIndex);
          messageEl = indexed[bestIdx]?.msg || null;
        }
      }

      let range = messageEl
        ? findBestTextRange(messageEl, stamp.selectedText, stamp.contextBefore || "", stamp.contextAfter || "", stamp.charOffset)
        : null;

      if (!range && messageEl && messageEl.parentElement) {
        range = findBestTextRange(
          messageEl.parentElement,
          stamp.selectedText,
          stamp.contextBefore || "",
          stamp.contextAfter || "",
          stamp.charOffset
        );
      }

      // Fallback for deep DOM nodes like tables or code blocks inside the message:
      // If exact character range could not be highlighted (e.g. text inside <td>), scroll directly to the table/code block element!
      if (!range && messageEl) {
        const tableOrCode = messageEl.querySelector("table, pre, code");
        if (tableOrCode) {
          return {
            rect: tableOrCode.getBoundingClientRect(),
            container: findScrollContainer(tableOrCode) || findScrollContainer(messageEl),
            element: tableOrCode,
            kind: "message",
          };
        }
      }

      // STRICT SCOPING: If messageEl WAS found for an AI chat message, DO NOT fall back to document.body!
      // Only search document.body if there was NO message element found at all.
      if (!range && !messageEl && (allowDocumentFallback || !hasMessageAnchor)) {
        const docOffset = typeof stamp.docCharOffset === "number" ? stamp.docCharOffset : stamp.charOffset;
        range = findBestTextRange(document.body, stamp.selectedText, stamp.contextBefore || "", stamp.contextAfter || "", docOffset);
      }

      if (range) {
        return {
          rect: range.getBoundingClientRect(),
          container: findScrollContainer(range.startContainer.parentElement || (messageEl || document.body)),
          range,
          kind: "range",
        };
      }
      if (messageEl) {
        return {
          rect: messageEl.getBoundingClientRect(),
          container: findScrollContainer(messageEl),
          element: messageEl,
          kind: "message",
        };
      }
      return null;
    };

    if (resolve(false)) {
      arriveSmoothly(() => resolve(false), desiredTop, highlightArrival);
      return true;
    }

    return huntForTarget(stamp, (isFallbackPhase) => resolve(isFallbackPhase), desiredTop);
  }

  // ============================================
  // SCROLL-POSITION BOOKMARKING (non-AI pages)
  // ============================================

  function getPageTitle() {
    return document.title || window.location.hostname;
  }

  function getContextPreview() {
    const elements = document.elementsFromPoint(window.innerWidth / 2, window.innerHeight / 2);
    for (const el of elements) {
      if (["P", "H1", "H2", "H3", "H4", "H5", "H6", "LI", "ARTICLE", "SECTION"].includes(el.tagName)) {
        const text = el.textContent?.trim();
        if (text && text.length > 10) return text.substring(0, 100).replace(/\s+/g, " ");
      }
    }
    return `${getScrollPercentage()}% scrolled`;
  }

  function createScrollStamp() {
    const scrollPercent = getScrollPercentage();
    let scrollY = window.scrollY || window.pageYOffset || 0;
    if (isPDF) {
      const pdfContainer = document.querySelector("#viewerContainer");
      if (pdfContainer) scrollY = pdfContainer.scrollTop;
    }
    return {
      id: `scroll_${scrollPercent}_${Date.now().toString(36)}`,
      type: isPDF ? "pdf" : "scroll",
      scrollPercent,
      scrollY,
      preview: getContextPreview(),
      pageTitle: getPageTitle(),
      title: "",
      timestamp: Date.now(),
      url: window.location.href,
      hostname: window.location.hostname,
      platform: isPDF ? "PDF" : "web",
    };
  }

  function scrollToPosition(stamp) {
    if (stamp.type === "pdf") {
      const pdfContainer = document.querySelector("#viewerContainer");
      if (pdfContainer && stamp.scrollY !== undefined) {
        pdfContainer.scrollTo({ top: stamp.scrollY, behavior: "smooth" });
        return true;
      }
    }
    if (stamp.scrollY !== undefined && stamp.scrollY > 0) {
      window.scrollTo({ top: stamp.scrollY, behavior: "smooth" });
      return true;
    }
    if (stamp.scrollPercent !== undefined && stamp.scrollPercent > 0) {
      const scrollHeight = document.documentElement.scrollHeight - window.innerHeight;
      window.scrollTo({ top: (stamp.scrollPercent / 100) * scrollHeight, behavior: "smooth" });
      return true;
    }
    return false;
  }

  // ============================================
  // STORAGE
  // ============================================

  function getStorageKey() {
    return `scrollstamp_${btoa(window.location.pathname).substring(0, 20)}`;
  }

  function isContextAlive() {
    try { return !!chrome?.runtime?.id; } catch { return false; }
  }

  // Re-read the per-site switch. Called on init and whenever the popup flips it,
  // so toggling takes effect on the open page without a reload.
  function refreshDisabledState() {
    if (!isContextAlive()) return;
    chrome.storage.local.get([DISABLED_SITES_KEY], (result) => {
      if (chrome.runtime.lastError) return;
      // Same www.-stripping the popup applies before storing.
      const host = window.location.hostname.replace(/^www\./, "");
      isSiteDisabled = (result[DISABLED_SITES_KEY] || []).includes(host);
      if (isSiteDisabled) {
        hideSelectionButton();
        closeSaveForm();
      }
    });
  }

  async function saveStamp(stamp) {
    const storageKey = getStorageKey();
    if (!isContextAlive()) return { status: "error", reason: "context_dead" };

    const tryRead = (retries) => new Promise((resolve) => {
      chrome.storage.local.get([storageKey], (result) => {
        if (chrome.runtime.lastError || !isContextAlive()) {
          if (retries > 0) return setTimeout(() => resolve(tryRead(retries - 1)), 200);
          return resolve({ status: "error", reason: "storage_read_failed" });
        }
        resolve({ status: "ok", stamps: result[storageKey] || [] });
      });
    });

    try {
      const readResult = await tryRead(1);
      if (readResult.status === "error") return readResult;

      const stamps = readResult.stamps;
      if (stamps.some((s) => s.id === stamp.id)) return { status: "duplicate" };
      stamps.push(stamp);

      return new Promise((resolve) => {
        chrome.storage.local.set({ [storageKey]: stamps }, () => {
          if (chrome.runtime.lastError || !isContextAlive()) {
            resolve({ status: "error", reason: "storage_write_failed" });
          } else {
            resolve({ status: "saved" });
          }
        });
      });
    } catch {
      return { status: "error", reason: "exception" };
    }
  }

  // ============================================
  // TOAST
  // ============================================

  function hideToast() {
    const existing = document.getElementById("scrollstamp-toast");
    if (!existing) return;
    existing.classList.add("scrollstamp-toast-hide");
    setTimeout(() => existing.remove(), 300);
  }

  // `options.persist` keeps the toast up until the caller clears it, which the
  // hunt needs: it can run for a while, and a message that vanished after two
  // seconds would leave the page looking frozen.
  function showToast(message, options = {}) {
    const existing = document.getElementById("scrollstamp-toast");
    if (existing) existing.remove();

    const toast = document.createElement("div");
    toast.id = "scrollstamp-toast";
    toast.textContent = message;
    document.body.appendChild(toast);

    if (options.persist) return;

    setTimeout(() => {
      // A toast replaced in the meantime is already detached; leave the new one be.
      if (!toast.isConnected) return;
      toast.classList.add("scrollstamp-toast-hide");
      setTimeout(() => toast.remove(), 300);
    }, 2000);
  }

  // ============================================
  // SAVE FORM (replaces browser prompt())
  // ============================================

  function closeSaveForm() {
    document.getElementById("scrollstamp-save-form")?.remove();
  }

  function showSaveForm(anchorRect, defaultName, onSave, onCancel) {
    closeSaveForm();

    const form = document.createElement("div");
    form.id = "scrollstamp-save-form";

    const header = document.createElement("div");
    header.className = "ssf-header";

    const icon = document.createElement("span");
    icon.className = "ssf-icon";
    icon.appendChild(createPinSvg(22, 22));

    const label = document.createElement("span");
    label.className = "ssf-label";
    label.textContent = "Save Bookmark";

    const closeBtn = document.createElement("button");
    closeBtn.className = "ssf-close";
    closeBtn.setAttribute("aria-label", "Cancel");
    closeBtn.textContent = "✕";

    header.appendChild(icon);
    header.appendChild(label);
    header.appendChild(closeBtn);

    const input = document.createElement("input");
    input.className = "ssf-input";
    input.type = "text";
    input.maxLength = 120;
    input.placeholder = "Bookmark name…";
    input.value = defaultName;

    const actions = document.createElement("div");
    actions.className = "ssf-actions";

    const cancelBtn = document.createElement("button");
    cancelBtn.className = "ssf-btn ssf-cancel-btn";
    cancelBtn.textContent = "Cancel";

    const saveBtn = document.createElement("button");
    saveBtn.className = "ssf-btn ssf-save-btn";
    saveBtn.textContent = "Save";

    actions.appendChild(cancelBtn);
    actions.appendChild(saveBtn);

    form.appendChild(header);
    form.appendChild(input);
    form.appendChild(actions);

    // Position near selection, clamped to viewport
    const formW = 264;
    const formH = 130;
    let top = Math.max(8, anchorRect.top - formH - 8);
    let left = Math.min(window.innerWidth - formW - 8, Math.max(8, anchorRect.left));
    if (top < 8 && anchorRect.bottom + formH + 8 < window.innerHeight) {
      top = anchorRect.bottom + 8;
    }
    form.style.top = `${top}px`;
    form.style.left = `${left}px`;

    document.body.appendChild(form);
    requestAnimationFrame(() => { input.focus(); input.select(); });

    const handleSave = () => {
      const title = input.value.trim() || defaultName;
      closeSaveForm();
      onSave(title);
    };

    const handleCancel = () => {
      closeSaveForm();
      onCancel();
    };

    saveBtn.addEventListener("click", handleSave);
    cancelBtn.addEventListener("click", handleCancel);
    closeBtn.addEventListener("click", handleCancel);

    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); handleSave(); }
      if (e.key === "Escape") { e.preventDefault(); handleCancel(); }
    });

    const clickOutside = (e) => {
      if (!form.contains(e.target)) {
        document.removeEventListener("mousedown", clickOutside, true);
        handleCancel();
      }
    };
    setTimeout(() => document.addEventListener("mousedown", clickOutside, true), 100);
  }

  // ============================================
  // SELECTION BUTTON (all pages)
  // ============================================

  function createPinSvg(width = 14, height = 14) {
    const img = document.createElement("img");
    if (isContextAlive()) {
      try {
        img.src = chrome.runtime.getURL("icon.png");
      } catch (_) {}
    }
    img.width = width;
    img.height = height;
    img.alt = "ScrollStamp";
    img.style.display = "block";
    img.style.objectFit = "contain";
    img.style.borderRadius = "3px";
    img.classList.add("scrollstamp-img-pin");
    return img;
  }

  function getSelectionButton() {
    if (selectionBtn && document.body.contains(selectionBtn)) return selectionBtn;

    selectionBtn = document.createElement("button");
    selectionBtn.id = "scrollstamp-select-btn";
    selectionBtn.setAttribute("aria-label", "Bookmark selected text");

    const pin = document.createElement("span");
    pin.className = "ssb-pin";
    pin.appendChild(createPinSvg(18, 18));

    const text = document.createElement("span");
    text.className = "ssb-text";
    text.textContent = "Bookmark";

    selectionBtn.appendChild(pin);
    selectionBtn.appendChild(text);
    document.body.appendChild(selectionBtn);
    return selectionBtn;
  }

  function showSelectionButton(rect) {
    if (isSiteDisabled) return;
    const btn = getSelectionButton();
    const btnHeight = 28;
    let top, left;

    if (isAIChat) {
      // Place it below the selection for AI chats to avoid overlapping native popovers/menus
      top = rect.bottom + 10;

      // Prevent overlapping with the bottom chat prompt input box (e.g. ChatGPT, Claude, Gemini, etc.)
      let limitY = window.innerHeight;
      const chatInput = document.getElementById("prompt-textarea") || 
                        document.querySelector('div[contenteditable="true"]') ||
                        document.querySelector('textarea[placeholder*="Ask"], textarea[placeholder*="Message"], textarea[placeholder*="Reply"]');
      if (chatInput) {
        const inputRect = chatInput.getBoundingClientRect();
        if (inputRect.top > window.innerHeight * 0.5) {
          limitY = inputRect.top - 20; // 20px safety buffer above input box
        }
      }

      if (top + btnHeight > limitY) {
        btn.style.display = "none";
        closeSaveForm();
        return;
      }

      top = Math.max(8, Math.min(window.innerHeight - btnHeight - 8, top));
      // Keep it horizontally aligned with the left edge of the selection, or adjusted if offscreen
      const btnWidth = 110;
      left = rect.left;
      if (left + btnWidth > window.innerWidth) {
        left = Math.max(8, window.innerWidth - btnWidth - 10);
      }
    } else {
      // Align vertically with the center of the selection to avoid top-aligned popovers on other pages
      top = rect.top + (rect.height - btnHeight) / 2;
      top = Math.max(8, Math.min(window.innerHeight - btnHeight - 8, top));

      // Place horizontally to the right of the selection (or left if at screen boundary)
      const btnWidth = 110; // approximate width of the button
      left = rect.right + 10;
      if (left + btnWidth > window.innerWidth) {
        left = Math.max(8, rect.left - btnWidth - 10);
      }
    }

    btn.style.top = `${top}px`;
    btn.style.left = `${left}px`;
    btn.style.display = "flex";
    hasActiveSelection = true;
  }

  function hideSelectionButton() {
    if (selectionBtn) selectionBtn.style.display = "none";
    hasActiveSelection = false;
  }

  function attachSelectionListener() {
    const btn = getSelectionButton();

    btn.addEventListener("mousedown", async (e) => {
      e.preventDefault();
      e.stopPropagation();

      const selection = window.getSelection();
      if (!selection || selection.rangeCount === 0) { hideSelectionButton(); return; }

      const range = selection.getRangeAt(0);
      const selectedText = selection.toString().trim();
      if (!selectedText) { hideSelectionButton(); return; }

      const startNode = range.startContainer;
      const nodeText = startNode.textContent || "";
      let messageEl = null, messageIndex = -1;
      if (isAIChat) {
        const messages = getAllChatMessages();
        for (let i = 0; i < messages.length; i++) {
          if (messages[i].contains(range.commonAncestorContainer)) {
            messageEl = messages[i]; messageIndex = i; break;
          }
        }
      }

      const offsetRoot = messageEl || document.body;
      const contextBefore = getContextBefore(offsetRoot, range.startContainer, range.startOffset, 60);
      const contextAfter = getContextAfter(offsetRoot, range.endContainer, range.endOffset, 60);
      const charOffset = textOffsetWithin(offsetRoot, range.startContainer, range.startOffset);
      const docCharOffset = textOffsetWithin(document.body, range.startContainer, range.startOffset);
      const stamp = createSelectionStamp(selectedText, contextBefore, contextAfter, messageEl, messageIndex, charOffset, docCharOffset);
      const anchorRect = range.getBoundingClientRect();

      hideSelectionButton();
      selection.removeAllRanges();

      showSaveForm(anchorRect, stamp.preview, async (title) => {
        stamp.title = title;
        const result = await saveStamp(stamp);
        if (result.status === "saved") showToast("Bookmarked!");
        else if (result.status === "duplicate") showToast("Already bookmarked");
        else showToast("Failed to save — try again");
      }, () => {});
    });

    document.addEventListener("mouseup", (e) => {
      if (isSiteDisabled) return;
      if (e.target?.closest?.("#scrollstamp-select-btn, #scrollstamp-save-form")) return;

      setTimeout(() => {
        const selection = window.getSelection();
        if (!selection || selection.isCollapsed) { hideSelectionButton(); return; }

        const text = selection.toString().trim();
        if (text.length < 3) { hideSelectionButton(); return; }

        const range = selection.getRangeAt(0);
        const ancestor = range.commonAncestorContainer;

        if (isAIChat) {
          const inAIMessage = getAllChatMessages().some((msg) => msg.contains(ancestor));
          if (!inAIMessage) { hideSelectionButton(); return; }
        } else {
          const el = ancestor.nodeType === Node.TEXT_NODE ? ancestor.parentElement : ancestor;
          if (el?.closest?.("input, textarea, select, [contenteditable]")) {
            hideSelectionButton(); return;
          }
        }

        showSelectionButton(range.getBoundingClientRect());
      }, 10);
    });

    document.addEventListener("mousedown", (e) => {
      if (e.target?.closest?.("#scrollstamp-select-btn, #scrollstamp-save-form")) return;
      hideSelectionButton();
    });

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { hideSelectionButton(); closeSaveForm(); }
    });

    const handleScroll = () => {
      if (!hasActiveSelection) return;

      const selection = window.getSelection();
      if (!selection || selection.isCollapsed) {
        hideSelectionButton();
        closeSaveForm();
        return;
      }

      const range = selection.getRangeAt(0);
      const rect = range.getBoundingClientRect();

      // Check if selection is within the viewport (vertical check)
      const isVisible = rect.top < window.innerHeight && rect.bottom > 0;

      if (isVisible) {
        showSelectionButton(rect);
      } else {
        // Just hide the selection button and close the save form visually, keeping hasActiveSelection true
        if (selectionBtn) selectionBtn.style.display = "none";
        closeSaveForm();
      }
    };

    window.addEventListener("scroll", handleScroll, { capture: true, passive: true });
  }

  // ============================================
  // PENDING SCROLL (cross-page navigation)
  // ============================================

  function checkPendingScroll() {
    if (!isContextAlive()) return;

    chrome.storage.local.get("scrollstamp_pending", (result) => {
      if (chrome.runtime.lastError || !result.scrollstamp_pending) return;

      const { stamp } = result.scrollstamp_pending;

      try {
        const pendingUrl = new URL(stamp.url);
        const currentUrl = new URL(window.location.href);
        if (currentUrl.origin !== pendingUrl.origin || currentUrl.pathname !== pendingUrl.pathname) return;
      } catch {
        return;
      }

      chrome.storage.local.remove("scrollstamp_pending");

      // Retry until DOM is ready (AI chats render messages asynchronously)
      let attempts = 0;
      const tryScroll = () => {
        attempts++;
        if ((stamp.type === "message" || stamp.type === "selection") && isAIChat) {
          if (getAssistantMessages().length === 0 && attempts < 12) {
            return setTimeout(tryScroll, 400);
          }
        }
        handleScrollTo(stamp);
      };

      setTimeout(tryScroll, 600);
    });
  }

  // ============================================
  // MESSAGE HANDLING
  // ============================================

  function handleScrollTo(stamp) {
    // A second click supersedes the first rather than racing it for the scroll
    // position. Note the return value now means "started", not "found" — a hunt
    // may still be running when this returns.
    cancelHunt("superseded");
    cancelArrival();
    if (stamp.type === "selection") return scrollToSelection(stamp);
    if (stamp.type === "message") return scrollToMessage(stamp);
    return scrollToPosition(stamp);
  }

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (!isContextAlive()) return false;

    if (request.action === "getStamps") {
      chrome.storage.local.get([getStorageKey()], (result) => {
        sendResponse({ stamps: result[getStorageKey()] || [] });
      });
      return true;
    }

    if (request.action === "scrollTo") {
      const success = handleScrollTo(request.stamp);
      sendResponse({ success });
      return true;
    }

    if (request.action === "deleteStamp") {
      const key = getStorageKey();
      chrome.storage.local.get([key], (result) => {
        const stamps = (result[key] || []).filter((s) => s.id !== request.stampId);
        chrome.storage.local.set({ [key]: stamps }, () => sendResponse({ success: true }));
      });
      return true;
    }

    if (request.action === "getMode") {
      sendResponse({ isAIChat, isPDF, platform: currentPlatform });
      return true;
    }

    if (request.action === "updateTitle") {
      const key = getStorageKey();
      chrome.storage.local.get([key], (result) => {
        const stamps = result[key] || [];
        const idx = stamps.findIndex((s) => s.id === request.stampId);
        if (idx !== -1) {
          stamps[idx].title = request.title;
          chrome.storage.local.set({ [key]: stamps }, () => sendResponse({ success: true }));
        } else {
          sendResponse({ success: false });
        }
      });
      return true;
    }
  });

  // ============================================
  // INITIALIZATION
  // ============================================

  function init() {
    currentPlatform = detectAIPlatform();
    isAIChat = currentPlatform !== null;
    isPDF = isPDFPage();

    // Attach listeners once; subsequent init calls (SPA nav) only re-detect platform
    if (!listenersAttached) {
      attachSelectionListener();
      listenersAttached = true;
    }

    refreshDisabledState();
    checkPendingScroll();
  }

  // Keep the open page in sync when the popup toggles this site on or off.
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && changes[DISABLED_SITES_KEY]) refreshDisabledState();
    });
  } catch (_) {}

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  // Re-detect platform on SPA navigation without duplicating listeners
  let lastUrl = location.href;
  new MutationObserver(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      setTimeout(() => {
        currentPlatform = detectAIPlatform();
        isAIChat = currentPlatform !== null;
        isPDF = isPDFPage();
        checkPendingScroll();
      }, 500);
    }
  }).observe(document.documentElement, { subtree: true, childList: true });
})();
