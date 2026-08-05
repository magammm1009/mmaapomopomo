/* =====================================================================
 * PomoRecordCore — 뽀모 글자수 기록 엔진 (순수 로직, Firebase 비의존)
 * ---------------------------------------------------------------------
 * 원본: VentWebApp.gs (docs/VentWebApp.gs.txt) — 파서·상태 전이·시스템 문구를
 * 원문 기준으로 이식. SnapshotLog 327행 + SheetEventLog 125행 리플레이로 검증.
 * 규칙 문서: 뽀모먼슬리/docs/DESIGN.md §1.3~1.4
 *
 * 원문과 의도적으로 다른 점 (2026-08-06 사용자 결정):
 *   - "닉네임+맨숫자"(리로12000 / 리로:12000 / 리로 12000 / …12,000자) 형태는
 *     기록 명령에서 제외. 일반 채팅("오늘은 1000자 쓸거예요!")이 유령 닉네임으로
 *     오인 기록되던 문제 차단. 명시적 표식(시작·+N·-N·/n)이 있는 형태만 인정.
 *
 * 사용처: ① 뽀모 앱 index.html ② 먼슬리 페이지 — 두 곳에 동일 파일 삽입.
 * 이 파일이 유일한 원본이며, 규칙 수정은 반드시 여기서만 한다.
 *
 * 상태 모양 (RTDB pomoRecords/state/{dayKey}/{slotKey}):
 *   { name, baseline, last, total, ep, epTotal, epLast, epStartedAt,
 *     base, current, updatedAt, lastRequestId, lastSysText }
 *   비어 있으면 null로 취급. 모든 함수는 순수: (state, ...) => 결과.
 * ===================================================================== */
(function (global) {
  'use strict';

  var SLOT_KEY_FORBIDDEN = /[.#$/\[\]]/g;

  function slotKey(name) {
    return String(name || '').trim().replace(SLOT_KEY_FORBIDDEN, '_');
  }

  /** 먼슬리 병합용 표시명: 끝의 " /n" 슬롯 접미사 제거 (시트 REGEXREPLACE와 동일) */
  function displayBaseName(name) {
    return String(name || '').replace(/\s*\/\d+\s*$/, '').trim();
  }

  /** VentWebApp normalizeName_: 제로폭 제거·공백 정리 */
  function normalizeName(name) {
    return String(name || '')
      .replace(/[​-‍﻿]/g, '')
      .trim()
      .replace(/\s+/g, ' ') || '';
  }

  function emptyState(name) {
    return {
      name: normalizeName(name),
      baseline: null, last: null, total: 0,
      ep: null, epTotal: null, epLast: null, epStartedAt: null,
      base: null, current: null,
      updatedAt: 0, lastRequestId: '', lastSysText: ''
    };
  }

  function normState(state, name) {
    var s = state && typeof state === 'object' ? state : null;
    if (!s) return emptyState(name);
    var out = emptyState(s.name || name);
    out.baseline = numOrNull(s.baseline);
    out.last = numOrNull(s.last);
    out.total = isNum(s.total) ? Math.trunc(Number(s.total)) : 0;
    out.ep = numOrNull(s.ep);
    out.epTotal = numOrNull(s.epTotal);
    out.epLast = numOrNull(s.epLast);
    out.epStartedAt = numOrNull(s.epStartedAt);
    out.base = numOrNull(s.base);
    out.current = numOrNull(s.current);
    out.updatedAt = isNum(s.updatedAt) ? Number(s.updatedAt) : 0;
    out.lastRequestId = String(s.lastRequestId || '');
    out.lastSysText = String(s.lastSysText || '');
    return out;
  }

  function isNum(v) { var n = Number(v); return v !== null && v !== '' && typeof v !== 'undefined' && isFinite(n); }
  function numOrNull(v) { return isNum(v) ? Math.trunc(Number(v)) : null; }

  /** VentWebApp formatNumber_/formatSigned_ 원문 그대로 */
  function fmtNum(n) {
    var num = Math.trunc(Number(n || 0));
    return String(num).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }
  function fmtSigned(n) {
    var num = Math.trunc(Number(n || 0));
    return num >= 0 ? ('+' + fmtNum(num)) : ('-' + fmtNum(Math.abs(num)));
  }

  /* =====================
   * 명령 파싱 — VentWebApp parse* 함수군 이식
   * 반환: { kind, value?, slot, name?(프리픽스로 지정된 대상), mode?, raw }
   *   kind ∈ snapshot|delta|baseline(시작)|episode|reset|dedup|
   *          baselineQuery|workMode|none
   * ===================== */
  var WORK_MODE_MAP = [
    { keys: ['집필', '작성', '집필중', '작성중'], label: '집필' },
    { keys: ['인풋', 'input'], label: '인풋' },
    { keys: ['수정'], label: '수정' },
    { keys: ['퇴고'], label: '퇴고' },
    { keys: ['시놉', '시놉시스'], label: '시놉' },
    { keys: ['트릿', '트리트', '트리트먼트'], label: '트릿' },
    { keys: ['자료조사', '리서치', '조사'], label: '자료조사' }
  ];
  var WORK_MODE_EMOJI = { '집필': '✍️', '인풋': '📥', '수정': '🛠️', '퇴고': '🪄', '시놉': '🧩', '트릿': '🧱', '자료조사': '📚' };
  var WORK_MODE_TAIL = {
    '집필': '달리는 중…', '인풋': '연료 채우는 중…', '퇴고': '리듬/호흡 점검 중…',
    '수정': '문장 다듬는 중…', '시놉': '구조 잡는 중…', '트릿': '장면 뼈대 세우는 중…',
    '자료조사': '자료 찾는 중…'
  };
  var BASELINE_KEYWORDS = ['기준', '기준조회', '기준확인', '오늘기준', '/기준', 'baseline'];
  var RESET_KEYWORDS = ['초기화', '오늘초기화', '기록초기화', '오늘리셋'];

  function normText_(t) {
    return String(t || '').trim().replace(/[：]/g, ':').replace(/\s+/g, ' ');
  }

  /** VentWebApp parseSlotAndName_ 이식: "/N" 슬롯 토큰 분리 */
  function parseSlot_(rawText, defaultName) {
    var text = normText_(rawText);
    var baseName = normalizeName(defaultName) || '익명';
    var slot = 0;

    // 기본 닉네임 자체가 "리로 /1" 형태면 자동 분해
    var nm = baseName.match(/^(.+?)\s*\/\s*(\d+)\s*$/);
    if (nm) {
      baseName = normalizeName(nm[1]) || baseName;
      slot = Math.max(0, parseInt(nm[2], 10) || 0);
    }

    var m = text.match(/^(.{1,30}?)\s*:\s*\/\s*(\d+)\s*(.*)$/);
    if (m) {
      slot = Math.max(0, parseInt(m[2], 10) || 0);
      return { slot: slot, message: (String(m[1]).trim() + ': ' + String(m[3] || '').trim()).trim(), baseName: baseName };
    }
    m = text.match(/^\/\s*(\d+)\s*(.*)$/);
    if (m) {
      slot = Math.max(0, parseInt(m[1], 10) || 0);
      return { slot: slot, message: String(m[2] || '').trim(), baseName: baseName };
    }
    m = text.match(/^(.{1,30}?)\s+\/\s*(\d+)\s*(.*)$/);
    if (m) {
      slot = Math.max(0, parseInt(m[2], 10) || 0);
      return { slot: slot, message: (String(m[1]).trim() + ' ' + String(m[3] || '').trim()).trim(), baseName: baseName };
    }
    return { slot: slot, message: text, baseName: baseName };
  }

  /** "이름: 명령" 콜론 프리픽스 분리 (reset/workMode/dedup 파서 공통) */
  function splitColonName_(s) {
    var m = s.match(/^([^:]{1,20})\s*:\s*(.+)$/);
    if (m) return { name: String(m[1]).trim(), rest: String(m[2]).trim() };
    return { name: '', rest: s };
  }

  function parseCommand(rawMsg, defaultName) {
    var slotInfo = parseSlot_(rawMsg, defaultName);
    var s = slotInfo.message;
    var slot = slotInfo.slot;
    if (!s) return { kind: 'none', slot: slot, raw: rawMsg };

    var res =
      parseDedup_(s) ||
      parseReset_(s) ||
      parseWorkMode_(s) ||
      parseEpisode_(s) ||
      parseStart_(s) ||
      parseScore_(s, slotInfo.baseName, slot > 0);

    if (!res) return { kind: 'none', slot: slot, raw: rawMsg };
    res.slot = slot;
    res.raw = String(rawMsg == null ? '' : rawMsg);
    return res;
  }

  function parseDedup_(s) {
    var p = splitColonName_(normText_(s));
    var t = p.rest.replace(/^\//, '').trim();
    if (t === '중복정리') return { kind: 'dedup', name: p.name || undefined };
    return null;
  }

  function parseReset_(s) {
    var p = splitColonName_(normText_(s));
    var t = p.rest.replace(/^\//, '').trim();
    if (RESET_KEYWORDS.indexOf(t) >= 0) return { kind: 'reset', name: p.name || undefined };
    return null;
  }

  function parseWorkMode_(s) {
    var p = splitColonName_(normText_(s));
    var t = p.rest.replace(/^\//, '').trim().replace(/\s+/g, '');
    for (var i = 0; i < WORK_MODE_MAP.length; i++) {
      var it = WORK_MODE_MAP[i];
      for (var j = 0; j < it.keys.length; j++) {
        var kk = it.keys[j].replace(/\s+/g, '');
        if (t === kk || t === kk + '중') return { kind: 'workMode', mode: it.label, name: p.name || undefined };
      }
    }
    return null;
  }

  function parseEpisode_(s) {
    var m = normText_(s).match(/^([^\d+\-:]{1,20})?\s*:?\s*(\/?\s*(새편|회차시작|새편시작|newepisode))\s*$/i);
    if (!m) return null;
    return { kind: 'episode', name: m[1] ? String(m[1]).trim() : undefined };
  }

  function parseStart_(s) {
    var t = normText_(s).replace(/,/g, '');
    if (!t) return null;
    var name;
    // '리로 시작 1234'
    var space = t.match(/^([^\d+\-:]{1,20})\s+(.*)$/);
    if (space && /^(\/?\s*(시작|start)\b)/i.test(String(space[2]).trim())) {
      name = String(space[1]).trim();
      t = String(space[2]).trim();
    }
    var m = t.match(/^([^\d+\-:]{1,20})?\s*:?\s*(\/?\s*(시작|start))\s*([0-9]{1,12})\s*$/i);
    if (!m) return null;
    if (m[1]) name = String(m[1]).trim() || name;
    var current = Math.trunc(Number(m[4] || 0));
    if (!isFinite(current) || current < 0) return null;
    return { kind: 'baseline', value: current, name: name || undefined };
  }

  function parseScore_(s, defaultBase, hasSlotToken) {
    var t = normText_(s).replace(/[＋]/g, '+').replace(/[－]/g, '-');
    t = t.replace(/\s*자\s*$/i, '').trim().replace(/,/g, '');
    if (!t) return null;

    // 기준 조회: "기준" / "리로 기준" / "리로:기준"
    var lower = t.toLowerCase();
    for (var i = 0; i < BASELINE_KEYWORDS.length; i++) {
      var kw = BASELINE_KEYWORDS[i];
      if (lower === kw || lower === kw.replace('/', '')) return { kind: 'baselineQuery' };
      if (lower.length > kw.length &&
          (lower.slice(-kw.length - 1) === (' ' + kw) || lower.slice(-kw.length - 1) === (':' + kw))) {
        var cut = t.slice(0, t.length - kw.length).trim().replace(/:$/, '').trim();
        if (cut && cut.length <= 20) return { kind: 'baselineQuery', name: cut };
      }
    }

    // 숫자만 / ±숫자만.
    // ⚠️ 원문의 닉네임+숫자(콜론·붙여쓰기·띄어쓰기) 스냅샷 형태는 지원하지 않음 —
    //    일반 채팅 오인 기록 방지(파일 상단 주석). 닉네임 지정 델타(리로:+300)만 유지.
    var pure = t.match(/^([+\-]?\d{1,12})$/);
    if (pure) {
      var num = Number(pure[1]);
      if (!isFinite(num)) return null;
      if (/^[+\-]/.test(pure[1])) {
        if (num === 0) return null;
        return { kind: 'delta', value: Math.trunc(num) };
      }
      return { kind: 'snapshot', value: Math.max(0, Math.trunc(num)) };
    }
    // 닉네임 프리픽스 숫자 형태.
    // - 슬롯 토큰(/n)이 있었으면 명시적 기록 표식이 있으므로 원문(VentWebApp) 문법 전체 허용:
    //   "리로: /2 3000" → "리로: 3000"(스냅샷), "리로 /2 3000" 등.
    // - 슬롯이 없으면 오인 기록 방지를 위해 부호 있는 델타(리로:+300, 리로 +300[본인만])만 허용.
    var numPart = hasSlotToken ? '([+\\-]?\\d{1,12})' : '([+\\-]\\d{1,12})';
    var colon = t.match(new RegExp('^([^\\d+\\-:]{1,20})\\s*:\\s*' + numPart + '$'));
    if (colon) {
      return numToCmd_(colon[2], normalizeName(colon[1]) || undefined);
    }
    var concat = hasSlotToken ? t.match(/^([^\d+\-:]{1,20})([+\-]?\d{1,12})$/) : null;
    if (concat) {
      return numToCmd_(concat[2], normalizeName(concat[1]) || undefined);
    }
    var spaced = t.match(new RegExp('^([^\\d+\\-:]{1,20})\\s+' + numPart + '$'));
    if (spaced) {
      var n2 = normalizeName(spaced[1]);
      if (hasSlotToken || (n2 && n2 === (normalizeName(defaultBase) || ''))) {
        return numToCmd_(spaced[2], hasSlotToken ? (n2 || undefined) : undefined);
      }
      return null;
    }
    return null;
  }

  /** 부호 있으면 델타(±0 거부), 없으면 스냅샷 — VentWebApp parseScoreCommand_ 공통 처리 */
  function numToCmd_(rawNum, name) {
    var num = Number(rawNum);
    if (!isFinite(num)) return null;
    if (/^[+\-]/.test(String(rawNum))) {
      if (num === 0) return null;
      return { kind: 'delta', value: Math.trunc(num), name: name };
    }
    return { kind: 'snapshot', value: Math.max(0, Math.trunc(num)), name: name };
  }

  /** 명령 대상 슬롯명: 프리픽스 이름(있으면) > 보낸 사람, 뒤에 " /n" (VentWebApp routeCommandSlot_) */
  function commandTargetName(parsed, user) {
    var base = normalizeName(parsed && parsed.name) || normalizeName(user) || '익명';
    // 이름 자체에 슬롯이 붙어 있으면 분해해 표준화
    var guard = 0, slot = Math.max(0, Number(parsed && parsed.slot) || 0);
    var m;
    while (guard++ < 8 && (m = base.match(/^(.+?)\s*\/\s*(\d+)\s*$/))) {
      if (!slot) slot = Math.max(0, parseInt(m[2], 10) || 0);
      base = normalizeName(m[1]) || '익명';
    }
    return slot > 0 ? (base + ' /' + slot) : base;
  }

  /* =====================
   * 채팅 명령 상태 전이 (순수) — VentWebApp handleCommand_ 이식
   * 반환: { state, events:[...], sysText, recorded }
   *   events[]: { type, cur, delta, totalAfter, raw } — 감사로그용
   *
   * ctx (선택): { otherSlotsTotal: number }
   *   같은 사람의 다른 작품 슬롯 오늘 합계. 주면 문구의 "오늘 누적"이
   *   하루 전체 합산(이 슬롯 + 다른 슬롯)으로 표시된다 (2026-08-06 사용자 요청 —
   *   먼슬리 합산과 동일 기준). 계산·상태 전이는 영향 없음, 표시 전용.
   * ===================== */
  function applyChatCommand(prevState, parsed, user, ctx) {
    var name = commandTargetName(parsed, user);
    var st = normState(prevState, name);
    st.name = name;
    var events = [], sysText = '', recorded = true;
    var otherTotal = (ctx && isNum(ctx.otherSlotsTotal)) ? Math.max(0, Math.trunc(Number(ctx.otherSlotsTotal))) : 0;
    function dayTotal() { return st.total + otherTotal; }

    switch (parsed.kind) {
      case 'snapshot': {
        var cur = Math.max(0, Math.trunc(parsed.value));
        var useEp = (st.ep != null && st.ep >= 1);
        var prev = useEp ? st.epLast : st.last;
        var hadPrev = (prev != null);
        var delta = hadPrev ? (cur - prev) : 0;
        if (delta < 0) delta = 0;
        st.total = Math.max(0, st.total + delta);
        if (useEp) { st.epTotal = Math.max(0, (st.epTotal || 0) + delta); st.epLast = cur; }
        if (!hadPrev && st.baseline == null) st.baseline = cur;
        st.last = cur;
        events.push({ type: hadPrev ? 'snapshot' : 'baseline', cur: cur, delta: delta, totalAfter: st.total, raw: parsed.raw });
        if (!hadPrev) {
          sysText = '📌 오늘 기준 저장: ' + name + ' ' + fmtNum(cur) + '자';
        } else {
          var sign = delta >= 0 ? '+' : '';
          sysText = '✅ ' + name + ' ' + sign + fmtNum(delta) + ' (현재 ' + fmtNum(cur) + ' / 오늘 누적 ' + fmtNum(dayTotal()) + ')';
        }
        break;
      }
      case 'delta': {
        var d = Math.trunc(parsed.value);
        st.total = Math.max(0, st.total + d);
        if (st.ep != null && st.ep >= 1) st.epTotal = Math.max(0, (st.epTotal || 0) + d);
        events.push({ type: 'delta', cur: null, delta: d, totalAfter: st.total, raw: parsed.raw });
        sysText = '➕ 반영: ' + name + ' ' + fmtSigned(d) + ' (오늘 누적 ' + fmtNum(dayTotal()) + '자)';
        break;
      }
      case 'baseline': { // '시작 N' — 오늘 초기화 후 기준 저장 (VentWebApp: resetToday_ + applySnapshotToLog_)
        var b = Math.max(0, Math.trunc(parsed.value));
        st = emptyState(name);
        events.push({ type: 'reset', cur: null, delta: null, totalAfter: 0, raw: '오늘 기록 초기화' });
        st.baseline = b; st.last = b;
        events.push({ type: 'baseline', cur: b, delta: 0, totalAfter: 0, raw: parsed.raw });
        sysText = '🚩 시작 스냅샷 저장: ' + name + ' ' + fmtNum(b) + '자 (오늘 누적 ' + fmtNum(dayTotal()) + '자)';
        break;
      }
      case 'episode': {
        st.ep = Math.max(0, st.ep || 0) + 1;
        st.epTotal = 0; st.epLast = 0; st.epStartedAt = Date.now();
        st.last = 0; // baseline은 유지 (VentWebApp startNewEpisode_)
        events.push({ type: 'episode_start', cur: null, delta: null, totalAfter: st.total, raw: '새편 시작' });
        sysText = '🆕 새편 시작! ' + name + ' ' + st.ep + '편을 0자부터 기록할게요. (기존 누적 ' + fmtNum(dayTotal()) + '자 유지)';
        break;
      }
      case 'reset': {
        st = emptyState(name);
        events.push({ type: 'reset', cur: null, delta: null, totalAfter: 0, raw: '오늘 기록 초기화' });
        sysText = '♻️ 오늘 기록 초기화 완료! (' + name + ')';
        break;
      }
      case 'dedup': {
        recorded = false; // RTDB 상태는 슬롯당 1개 — 정리할 중복 행이 구조적으로 없음
        sysText = '🧹 중복 행이 없어요!';
        break;
      }
      case 'baselineQuery': {
        recorded = false;
        if (st.baseline == null) {
          sysText = 'ℹ️ ' + name + ' 오늘 기준값이 아직 없어요. 먼저 스냅샷(현재 글자수)을 입력해줘!';
        } else {
          var curTxt = (st.last == null) ? '-' : (fmtNum(st.last) + '자');
          sysText = '📌 오늘 기준: ' + name + ' ' + fmtNum(st.baseline) + '자 (현재 ' + curTxt + ' / 오늘 누적 ' + fmtNum(dayTotal()) + '자)';
        }
        break;
      }
      case 'workMode': {
        recorded = false;
        sysText = WORK_MODE_EMOJI[parsed.mode] + ' ' + parsed.mode + ' 모드 ON! ' + name + ' ' + WORK_MODE_TAIL[parsed.mode];
        break;
      }
      default: {
        recorded = false;
        sysText = '';
      }
    }
    if (recorded) st.updatedAt = Date.now();
    return { state: st, events: events, sysText: sysText, recorded: recorded };
  }

  /* =====================
   * 직접 입력(시트 탭) 상태 전이 (순수) — 시트 handleManualEntry_ 동작 이식
   *   kind 'base'   : base=N, total=0, current 초기화
   *   kind 'current': 기준 필수(BASE_REQUIRED), delta = N - 직전 current(없으면 base),
   *                   total = max(0, N - base)
   * 오류: { error, message } — VentWebApp saveDirectSheetEntry 문구 그대로
   * ===================== */
  function applyDirectEntry(prevState, kind, value, name) {
    var nm = normalizeName(name).slice(0, 12);
    if (!nm) return { error: 'NAME_REQUIRED', message: '상단 닉네임을 먼저 입력해 주세요.' };
    var valueText = String(value == null ? '' : value).replace(/,/g, '').trim();
    if (!/^\d{1,12}$/.test(valueText)) {
      return { error: 'BAD_VALUE', message: '0 이상의 숫자만 입력해 주세요.' };
    }
    var n = parseInt(valueText, 10);
    var st = normState(prevState, nm);
    st.name = st.name || nm;

    var ev, message;
    if (kind === 'base') {
      st.base = n; st.current = null; st.total = 0;
      ev = { type: 'manual_base', cur: n, delta: 0, totalAfter: 0, raw: valueText };
      message = '“' + nm + '” 기준 ' + fmtNum(n) + '자를 저장했습니다.';
    } else if (kind === 'current') {
      if (st.base == null) {
        return { error: 'BASE_REQUIRED', message: '현재 글자수를 반영하기 전에 기준 글자수를 먼저 저장해 주세요.' };
      }
      var prev = (st.current == null) ? st.base : st.current;
      var delta = n - prev;
      st.current = n;
      st.total = Math.max(0, n - st.base);
      ev = { type: 'manual_current', cur: n, delta: delta, totalAfter: st.total, raw: valueText };
      message = '“' + nm + '” 현재 ' + fmtNum(n) + '자를 반영했습니다.';
    } else {
      return { error: 'BAD_KIND', message: '기준 또는 현재 입력만 가능합니다.' };
    }
    st.updatedAt = Date.now();
    return { state: st, event: ev, message: message };
  }

  /* 먼슬리 피벗 (시트 Monthly와 동일): days/{month} 서브트리 → {닉네임: 합계} */
  function pivotMonth(monthDays) {
    var out = {};
    var dd = monthDays || {};
    for (var day in dd) {
      var slots = dd[day] || {};
      for (var k in slots) {
        var v = slots[k] || {};
        var nm = displayBaseName(v.name != null ? v.name : k);
        if (!nm) continue;
        out[nm] = (out[nm] || 0) + (Number(v.total) || 0);
      }
    }
    return out;
  }

  /* 월 요약 (시트 Summary와 동일): 총합 / 기록건수 / 건당평균 */
  function summarizeMonth(monthDays) {
    var sum = 0, count = 0;
    var dd = monthDays || {};
    for (var day in dd) {
      var slots = dd[day] || {};
      for (var k in slots) {
        sum += Number((slots[k] || {}).total) || 0;
        count += 1;
      }
    }
    return { sum: sum, count: count, avg: count ? sum / count : 0 };
  }

  var api = {
    slotKey: slotKey,
    displayBaseName: displayBaseName,
    normalizeName: normalizeName,
    emptyState: emptyState,
    normState: normState,
    fmtNum: fmtNum,
    fmtSigned: fmtSigned,
    parseCommand: parseCommand,
    commandTargetName: commandTargetName,
    applyChatCommand: applyChatCommand,
    applyDirectEntry: applyDirectEntry,
    pivotMonth: pivotMonth,
    summarizeMonth: summarizeMonth
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api; // Node 테스트용
  global.PomoRecordCore = api;
})(typeof window !== 'undefined' ? window : globalThis);
