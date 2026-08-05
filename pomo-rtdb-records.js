/* =====================================================================
 * POMO_RTDB_RECORDS — 글자수 기록 어댑터 (Apps Script → Firebase RTDB)
 * ---------------------------------------------------------------------
 * 뽀모 앱 index.html의 gasCallPromise_가 아래 3개 함수를 호출하면
 * Apps Script(JSONP) 대신 이 어댑터가 RTDB에서 직접 처리한다.
 *   - processCommandOnly(sid, user, msg, requestId, dayKey)
 *   - getDirectSheetState(sid)
 *   - saveDirectSheetEntry(sid, name, index, kind, value, requestId, dayKey)
 * 나머지 함수(enterPresence/joinOrPing/leavePresence/syncPresenceSnapshot/
 * claimHost 등)는 기존 Apps Script 경로를 그대로 사용한다.
 *
 * 응답 계약은 VentWebApp.gs 원문과 동일하게 맞췄다
 * (docs/VentWebApp.gs.txt 라인 885~905 / 912~1056 / 1058 / 1138~1202).
 * 세션 검사(SESSION_CHANGED)만 없다 — RTDB에는 세션 개념이 없다.
 *
 * 기록 규칙 자체는 pomo-record-engine.js(PomoRecordCore)가 전담하며
 * 이 파일은 RTDB 입출력·트랜잭션·중복 방지·응답 형태만 담당한다.
 *
 * RTDB 경로 (DESIGN.md §2.1) — pomoRecords 밖의 노드는 절대 건드리지 않는다.
 *   pomoRecords/state/{dayKey}/{slotKey}
 *   pomoRecords/days/{monthKey}/{dayKey}/{slotKey} = { name, total }
 *   pomoRecords/months/{monthKey} = true
 *   pomoRecords/events/{dayKey}/{pushId}
 * ===================================================================== */
(function (global) {
  'use strict';

  var ROOT = 'pomoRecords';
  var KST_OFFSET_MS = 9 * 60 * 60 * 1000;
  var DIRECT_BLOCK_COUNT = 12;      // 원문 DIRECT_SHEET_BLOCKS.length (오늘 시트 칸 수)
  var FB_WAIT_TIMEOUT_MS = 20000;   // Firebase 모듈 로드 대기 한도
  var HANDLED = {
    processCommandOnly: true,
    getDirectSheetState: true,
    saveDirectSheetEntry: true
  };

  function noop() {}

  /* ---------- 공통 ---------- */

  function kstDate() { return new Date(Date.now() + KST_OFFSET_MS); }
  function todayKey() { return kstDate().toISOString().slice(0, 10); }
  function isDayKey(v) { return /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')); }
  function monthKeyOf(dayKey) { return String(dayKey).slice(0, 7); }
  /** 기존 시트 탭 이름과 같은 'MMDD' 표기 */
  function sheetNameOf(dayKey) { return String(dayKey).slice(5, 7) + String(dayKey).slice(8, 10); }

  /** VentWebApp makeTs_ 이식: KST 12시간제 '오후 3:05' */
  function makeTs() {
    var d = kstDate();
    var h = d.getUTCHours();
    var ampm = h >= 12 ? '오후' : '오전';
    var hh = (h % 12) || 12;
    var mm = String(d.getUTCMinutes());
    if (mm.length < 2) mm = '0' + mm;
    return ampm + ' ' + hh + ':' + mm;
  }

  function core() {
    var C = global.PomoRecordCore;
    if (!C) throw new Error('기록 엔진(pomo-record-engine.js)이 로드되지 않았습니다.');
    return C;
  }

  function fbNow() {
    return global.__POMO_FB_MOCK || global.FB || null;
  }

  function fbUsable(fb) {
    return !!(fb && fb.db && typeof fb.ref === 'function' && typeof fb.get === 'function' &&
              typeof fb.set === 'function' && typeof fb.push === 'function' &&
              typeof fb.runTransaction === 'function');
  }

  /** Firebase 모듈 스크립트는 나중에 로드되므로 준비될 때까지 짧게 폴링한다. */
  function waitFb() {
    var now = fbNow();
    if (fbUsable(now)) return Promise.resolve(now);
    return new Promise(function (resolve, reject) {
      var deadline = Date.now() + FB_WAIT_TIMEOUT_MS;
      (function poll() {
        var fb = fbNow();
        if (fbUsable(fb)) { resolve(fb); return; }
        if (Date.now() > deadline) {
          reject(new Error('Firebase 준비가 늦어 기록을 반영하지 못했습니다. 잠시 후 자동 재시도합니다.'));
          return;
        }
        setTimeout(poll, 80);
      })();
    });
  }

  function ensureReady() {
    return waitFb().then(function (fb) {
      if (typeof fb.ensureAnonAuth !== 'function') return fb;
      return Promise.resolve(fb.ensureAnonAuth()).then(function () { return fb; });
    });
  }

  function statePath(day, key) { return ROOT + '/state/' + day + '/' + key; }
  function dayStatePath(day) { return ROOT + '/state/' + day; }
  function dayEntryPath(day, key) { return ROOT + '/days/' + monthKeyOf(day) + '/' + day + '/' + key; }
  function monthPath(day) { return ROOT + '/months/' + monthKeyOf(day); }
  function eventsPath(day) { return ROOT + '/events/' + day; }

  function snapVal(snap) {
    return snap && typeof snap.val === 'function' ? snap.val() : null;
  }

  function getVal(fb, path) {
    return Promise.resolve(fb.get(fb.ref(fb.db, path))).then(snapVal);
  }

  /** RTDB는 undefined를 거부한다. undefined는 버리고 null은 그대로 둔다(키 삭제). */
  function sanitize(obj) {
    var out = {};
    for (var k in obj) {
      if (!Object.prototype.hasOwnProperty.call(obj, k)) continue;
      if (obj[k] === undefined) continue;
      out[k] = obj[k];
    }
    return out;
  }

  /**
   * 상태 트랜잭션. mutator(cur)가 undefined를 반환하면 중단(abort).
   * 반환: { value, aborted }
   */
  function runStateTx(fb, day, key, mutator) {
    var ref = fb.ref(fb.db, statePath(day, key));
    return Promise.resolve(fb.runTransaction(ref, mutator)).then(function (res) {
      return {
        value: res && res.snapshot ? snapVal(res.snapshot) : null,
        aborted: !!(res && res.committed === false)
      };
    });
  }

  /**
   * 트랜잭션 커밋 후 원장/월 인덱스/감사로그 반영.
   * days는 증분이 아니라 확정 total의 절대값 set이라 드리프트가 없다.
   * 응답을 지연시키지 않도록 기다리지 않고(fire-and-forget) 던진다.
   * events는 배열(applyChatCommand) 또는 단일 객체(applyDirectEntry) 모두 받는다.
   */
  function syncAfterCommit(fb, day, key, state, events, by) {
    try {
      var name = String((state && state.name) || key);
      var total = Number(state && state.total) || 0;
      Promise.resolve(fb.set(fb.ref(fb.db, dayEntryPath(day, key)), { name: name, total: total })).catch(noop);
      Promise.resolve(fb.set(fb.ref(fb.db, monthPath(day)), true)).catch(noop);
      var list = !events ? [] : (Object.prototype.toString.call(events) === '[object Array]' ? events : [events]);
      for (var i = 0; i < list.length; i++) {
        var event = list[i];
        if (!event) continue;
        var payload = sanitize({
          ts: Date.now(),
          name: name,
          type: event.type == null ? null : String(event.type),
          cur: event.cur == null ? null : Number(event.cur),
          delta: event.delta == null ? null : Number(event.delta),
          totalAfter: event.totalAfter == null ? null : Number(event.totalAfter),
          raw: event.raw == null ? null : String(event.raw),
          by: String(by == null ? '' : by)
        });
        var evRef = fb.push(fb.ref(fb.db, eventsPath(day)));
        Promise.resolve(fb.set(evRef, payload)).catch(noop);
      }
    } catch (e) { /* 감사로그 실패가 사용자 응답을 막지 않게 한다 */ }
  }

  /* ---------- 채팅 기록 명령 (원문 processCommandOnly) ---------- */

  function processCommandOnly(sid, rawUser, rawMsg, rawRequestId, rawDayKey) {
    var C = core();
    var user = String(rawUser == null ? '' : rawUser).trim() || '익명';
    var message = String(rawMsg == null ? '' : rawMsg).trim();
    var requestId = String(rawRequestId == null ? '' : rawRequestId).trim().slice(0, 180);
    var requestDayKey = String(rawDayKey == null ? '' : rawDayKey).trim();

    if (!message) return Promise.resolve({ ok: false, reason: 'EMPTY' });

    var today = todayKey();
    if (requestDayKey && requestDayKey !== today) {
      return Promise.resolve({ ok: false, reason: 'DAY_CHANGED', dayKey: today });
    }
    var day = isDayKey(requestDayKey) ? requestDayKey : today;

    var parsed = C.parseCommand(message, user);
    if (!parsed || parsed.kind === 'none') {
      return Promise.resolve({ ok: true, hadCommand: false, requestId: requestId });
    }

    var name = C.commandTargetName(parsed, user);
    var key = C.slotKey(name);
    if (!key) return Promise.resolve({ ok: true, hadCommand: false, requestId: requestId });

    var ts = makeTs();

    return ensureReady().then(function (fb) {
      // 기록하지 않는 명령은 트랜잭션을 쓰지 않는다. 실제 Firebase 트랜잭션은
      // 로컬 캐시가 비어 있으면 null로 1회 실행되고, abort(undefined 반환) 시
      // 서버 값을 다시 읽지 않으므로 기준 조회가 스테일 응답을 낼 수 있다.
      if (parsed.kind === 'workMode' || parsed.kind === 'dedup') {
        var r0 = C.applyChatCommand(null, parsed, user);
        return { ok: true, hadCommand: true, ts: ts, sysText: r0.sysText, requestId: requestId };
      }
      if (parsed.kind === 'baselineQuery') {
        return getVal(fb, statePath(day, key)).then(function (cur0) {
          var r1 = C.applyChatCommand(cur0, parsed, user);
          return { ok: true, hadCommand: true, ts: ts, sysText: r1.sysText, requestId: requestId };
        });
      }

      var run = null;
      return runStateTx(fb, day, key, function (cur) {
        // 큐 재시도로 같은 requestId가 다시 와도 상태를 두 번 바꾸지 않는다.
        if (requestId && cur && String(cur.lastRequestId || '') === requestId) {
          run = { dup: true, state: cur };
          return cur;
        }
        var r = C.applyChatCommand(cur, parsed, user);
        // 안전망: 위에서 못 거른 비기록 명령이 있어도 상태는 건드리지 않는다.
        if (!r.recorded) { run = { readOnly: true, sysText: r.sysText }; return undefined; }
        var st = sanitize(r.state);
        st.lastRequestId = requestId;
        st.lastSysText = String(r.sysText || '');
        st.lastTs = ts;
        run = { events: r.events, state: st };
        return st;
      }).then(function (tx) {
        if (run && run.readOnly) {
          return { ok: true, hadCommand: true, ts: ts, sysText: run.sysText, requestId: requestId };
        }
        var state = tx.value || (run && run.state) || null;
        if (run && run.dup) {
          return {
            ok: true, hadCommand: true,
            ts: String((state && state.lastTs) || ts),
            sysText: String((state && state.lastSysText) || ''),
            requestId: requestId, duplicate: true
          };
        }
        syncAfterCommit(fb, day, key, state, run && run.events, user);
        return {
          ok: true, hadCommand: true, ts: ts,
          sysText: String((state && state.lastSysText) || (run && run.state && run.state.lastSysText) || ''),
          requestId: requestId
        };
      });
    });
  }

  /* ---------- 직접 입력(기존 시트 일별 탭) ---------- */

  /**
   * 직접 입력 칸 목록. 채팅으로만 기록된 상태(base/current 없음)는 제외해
   * 기존 시트 탭과 같은 칸 구성을 유지한다. 정렬은 표시 이름 가나다순.
   */
  function directSlots(C, all) {
    var out = [];
    var data = all || {};
    for (var k in data) {
      if (!Object.prototype.hasOwnProperty.call(data, k)) continue;
      var st = C.normState(data[k], k);
      if (st.base == null && st.current == null) continue;
      out.push({
        key: k,
        rawName: st.name || k,
        name: C.displayBaseName(st.name || k),
        base: st.base,
        total: Number(st.total) || 0
      });
    }
    out.sort(function (a, b) {
      var c = String(a.name).localeCompare(String(b.name), 'ko');
      if (c) return c;
      return String(a.rawName).localeCompare(String(b.rawName), 'ko');
    });
    return out;
  }

  /** 원문 directReadBlock_과 같은 모양: { index, id, name, total, base, position } */
  function blockOf(index, slot) {
    return {
      index: Number(index),
      id: slot ? String(slot.key) : ('block' + Number(index)),
      name: slot ? String(slot.name) : '',
      total: slot ? Number(slot.total) || 0 : 0,
      base: slot ? slot.base : null,
      position: (Number(index) + 1) + '번 칸'
    };
  }

  /** 사용 중인 칸 + 빈 칸 = 항상 12칸(원문 칸 수). 12명을 넘으면 넘는 만큼만 늘린다. */
  function buildBlocks(list) {
    var total = Math.max(DIRECT_BLOCK_COUNT, list.length);
    var blocks = [];
    for (var i = 0; i < total; i++) blocks.push(blockOf(i, i < list.length ? list[i] : null));
    return blocks;
  }

  function readBlocks(fb, day) {
    var C = core();
    return getVal(fb, dayStatePath(day)).then(function (all) {
      var list = directSlots(C, all || {});
      return { all: all || {}, list: list, blocks: buildBlocks(list) };
    });
  }

  function getDirectSheetState() {
    var day = todayKey();
    return ensureReady().then(function (fb) {
      return readBlocks(fb, day);
    }).then(function (read) {
      return {
        ok: true,
        sheetName: sheetNameOf(day),
        updatedAtMs: Date.now(),
        blocks: read.blocks
      };
    });
  }

  /**
   * 같은 닉네임으로 칸을 하나 더 쓰는 경우의 새 슬롯 이름.
   * 기존 시트에서 같은 닉네임 칸이 여러 개면 먼슬리에서 합산되던 동작을
   * "이름 /2" 슬롯 + displayBaseName 병합으로 그대로 재현한다.
   */
  function nextSlotName(list, wanted) {
    var used = {};
    var found = false;
    for (var i = 0; i < list.length; i++) {
      if (list[i].name !== wanted) continue;
      found = true;
      var m = String(list[i].rawName).match(/\s*\/(\d+)\s*$/);
      used[m ? Number(m[1]) : 0] = true;
    }
    if (!found || !used[0]) return wanted;
    var n = 2;
    while (used[n]) n += 1;
    return wanted + ' /' + n;
  }

  function saveDirectSheetEntry(sid, viewerName, blockIndex, rawKind, rawValue, rawRequestId, rawDayKey) {
    var C = core();
    var name = C.normalizeName(viewerName).slice(0, 12);
    var index = parseInt(blockIndex, 10);
    var kind = String(rawKind == null ? '' : rawKind).trim();
    var requestId = String(rawRequestId == null ? '' : rawRequestId).trim().slice(0, 180);
    var requestDayKey = String(rawDayKey == null ? '' : rawDayKey).trim();
    var valueText = String(rawValue == null ? '' : rawValue).replace(/,/g, '').trim();

    // 검증 순서·문구 모두 원문 saveDirectSheetEntry 그대로
    if (!name) return Promise.resolve({ ok: false, reason: 'NAME_REQUIRED', message: '상단 닉네임을 먼저 입력해 주세요.' });
    if (!requestId) return Promise.resolve({ ok: false, reason: 'REQUEST_ID_REQUIRED', message: '안전한 기록 번호가 없습니다. 새로고침 후 다시 시도해 주세요.' });
    if (!isFinite(index) || Math.floor(index) !== index || index < 0) {
      return Promise.resolve({ ok: false, reason: 'BAD_BLOCK', message: '시트 입력 칸을 찾지 못했습니다.' });
    }
    if (kind !== 'base' && kind !== 'current') {
      return Promise.resolve({ ok: false, reason: 'BAD_KIND', message: '기준 또는 현재 입력만 가능합니다.' });
    }
    if (!/^\d{1,12}$/.test(valueText)) {
      return Promise.resolve({ ok: false, reason: 'BAD_VALUE', message: '0 이상의 숫자만 입력해 주세요.' });
    }
    var value = parseInt(valueText, 10);

    var today = todayKey();
    if (requestDayKey && requestDayKey !== today) {
      return Promise.resolve({
        ok: false, reason: 'DAY_CHANGED', dayKey: today,
        message: '날짜가 바뀌어 이전 날짜의 미처리 입력은 오늘 시트에 반영하지 않았습니다.'
      });
    }
    var day = isDayKey(requestDayKey) ? requestDayKey : today;
    var sheetName = sheetNameOf(day);
    var message = kind === 'base'
      ? '“' + name + '” 기준 ' + C.fmtNum(value) + '자를 저장했습니다.'
      : '“' + name + '” 현재 ' + C.fmtNum(value) + '자를 반영했습니다.';

    var fbRef = null;
    return ensureReady().then(function (fb) {
      fbRef = fb;
      return readBlocks(fb, day);
    }).then(function (read) {
      if (index >= read.blocks.length) {
        return { ok: false, reason: 'BAD_BLOCK', message: '시트 입력 칸을 찾지 못했습니다.' };
      }
      var currentBlock = read.blocks[index];
      if (currentBlock.name && C.normalizeName(currentBlock.name) !== name) {
        return {
          ok: false, reason: 'NAME_MISMATCH', existingName: currentBlock.name,
          message: '이 칸은 “' + currentBlock.name + '” 님의 칸입니다. 상단 닉네임과 같은 칸만 입력할 수 있어요.'
        };
      }
      if (kind === 'current' && currentBlock.base === null) {
        return { ok: false, reason: 'BASE_REQUIRED', message: '현재 글자수를 반영하기 전에 기준 글자수를 먼저 저장해 주세요.' };
      }

      // 사용 중인 칸이면 그 슬롯 그대로, 빈 칸이면 새 슬롯(같은 닉네임이면 " /n")
      var target = index < read.list.length ? read.list[index].rawName : nextSlotName(read.list, name);
      var key = C.slotKey(target);
      if (!key) return { ok: false, reason: 'NAME_REQUIRED', message: '상단 닉네임을 먼저 입력해 주세요.' };

      // 콜드 캐시 대비: 실제 Firebase 트랜잭션은 첫 실행에 null을 줄 수 있다.
      // 방금 서버에서 읽은 상태를 폴백으로 쓰면, 서버가 정말 null이 아닐 경우
      // 커밋 충돌 → 실값 재실행으로 자동 수렴하므로 안전하다.
      var pre = read.all[key] || null;

      var run = null;
      return runStateTx(fbRef, day, key, function (cur) {
        var base = cur || pre;
        if (base && String(base.lastRequestId || '') === requestId) {
          run = { dup: true, state: base };
          return cur === undefined ? base : (cur || base);
        }
        var r = C.applyDirectEntry(base, kind, value, name);
        if (!r || r.error) { run = { error: (r && r.error) || 'BAD_VALUE', message: r && r.message }; return undefined; }
        var st = sanitize(r.state);
        // 슬롯 키와 이름을 항상 일치시킨다(엔진의 12자 절단·같은 닉네임 " /n" 대응).
        st.name = target;
        st.lastRequestId = requestId;
        run = { event: r.event, state: st };
        return st;
      }).then(function (tx) {
        if (run && run.error) {
          return { ok: false, reason: run.error, message: run.message || '입력값을 확인해 주세요.' };
        }
        var state = tx.value || (run && run.state) || null;
        if (run && !run.dup) syncAfterCommit(fbRef, day, key, state, run.event, name);
        var st = C.normState(state, target);
        var block = blockOf(index, {
          key: key,
          rawName: st.name || target,
          name: C.displayBaseName(st.name || target),
          base: st.base,
          total: Number(st.total) || 0
        });
        var result = {
          ok: true, requestId: requestId, sheetName: sheetName,
          kind: kind, value: value, block: block, message: message
        };
        if (run && run.dup) result.duplicate = true;
        return result;
      });
    });
  }

  /* ---------- 라우팅 진입점 ---------- */

  function handles(fnName) {
    return HANDLED[String(fnName || '')] === true;
  }

  function call(fnName, args) {
    var a = args || [];
    var fn = String(fnName || '');
    try {
      if (fn === 'processCommandOnly') return processCommandOnly(a[0], a[1], a[2], a[3], a[4]);
      if (fn === 'getDirectSheetState') return getDirectSheetState(a[0]);
      if (fn === 'saveDirectSheetEntry') return saveDirectSheetEntry(a[0], a[1], a[2], a[3], a[4], a[5], a[6]);
    } catch (e) {
      return Promise.reject(e);
    }
    return Promise.reject(new Error('POMO_RTDB_RECORDS가 처리하지 않는 함수입니다: ' + fn));
  }

  var api = {
    VERSION: 'pomo-rtdb-records-v4.5.0',
    ROOT: ROOT,
    handles: handles,
    call: call,
    processCommandOnly: processCommandOnly,
    getDirectSheetState: getDirectSheetState,
    saveDirectSheetEntry: saveDirectSheetEntry,
    todayKey: todayKey,
    sheetNameOf: sheetNameOf,
    makeTs: makeTs
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api; // Node 테스트용
  global.POMO_RTDB_RECORDS = api;
})(typeof window !== 'undefined' ? window : globalThis);
