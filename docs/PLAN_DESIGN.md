# 설교 설계도 — 설계 기준

작성: 2026-11-24. 찾은 자료를 설교 구조로 엮는 화면이다. 신학 서재 **앱**과 **웹 신학서재**가 같은 화면 코드를 쓴다.

## 1. 무엇을 만드나

- **A. 설교 설계도**: 설교 제목·본문·설교 정보·중심 사상에, 서론·대지(본론)·결론·더 공부할 것 가지를 두고 자료를 배치한다.
- **B. 어디서나 담기**: 성경 본문 절, 주석 풀이, 사전, 소논문, 서재 책의 쪽, AI 본문연구 보고서에서 글을 골라 **자료함**에 담거나 가지에 바로 넣는다. 출처는 자동으로 붙는다.
- **C. 두 가지 보기**: 같은 설계도를 **순서 보기**(개요)와 **마인드맵**으로 본다. 어느 쪽에서 고쳐도 같은 자료가 바뀐다.
- **D. AI 연결**: 설계도를 AI 본문연구로 보내 "빈 가지에 넣을 자료 찾기" 또는 "원고 초안 쓰기"를 맡긴다. AI는 사용자가 연구 화면에서 고르고 시작한다(누르기 전에는 돈이 들지 않는다).

다른 프로그램(MJ Bible Study)의 "설교 설계도"에서 생각을 얻었지만 화면·문구·그림은 베끼지 않는다. 신학 서재의 디자인 기준(`UI_DESIGN.md`, "조용한 서재")을 따른다.

## 2. 파일

| 파일 | 내용 |
|-|-|
| `ui/plan.js` | 화면 전체(자료 모델·순서 보기·자료함·내보내기). `window.SermonPlan` 을 내놓는다. |
| `ui/plan-map.js` | 마인드맵 보기(SVG). `window.SermonPlanMap` 을 내놓는다. `plan.js` 가 부른다. |
| `ui/plan.css` | 두 보기의 모양. 색은 `--pl-*` 변수만 쓰고, 앱·웹이 자기 색으로 그 변수를 채운다. |
| 웹 | 같은 세 파일을 `static/sermon-plan.js`, `static/sermon-plan-map.js`, `static/sermon-plan.css` 로 복사해 쓴다. |

세 파일은 **바깥 것에 기대지 않는다**: 프레임워크·CDN·글꼴 요청 없음, `fetch`·`invoke`·`localStorage` 직접 호출 없음(모두 host 를 거친다), 전역 변수는 위 두 개뿐, 클래스 이름은 모두 `pl-` 로 시작한다. 인라인 `<script>`·`eval` 없음. 아이콘은 인라인 SVG(이모지 금지).

## 3. 자료 모델

```js
Plan = {
  id: "p1732412345678",          // 만든 시각으로 지은 id
  title: "함께 지어져 갑니다",       // 설교 제목
  ref: "삼하 13:1-22",             // 설교 본문(글자 그대로)
  info: { date: "2026-11-29", place: "", service: "금요기도회", preacher: "" },
  big: "욕망은 사람을 잔인하게 만든다",  // 중심 사상(한 문장)
  branches: [Branch],             // 화면 차례 = 설교 차례
  updated: 1732412345678,         // 고친 시각(ms)
}
Branch = {
  id: "b1",
  kind: "intro" | "point" | "outro" | "more",   // 서론 | 대지 | 결론 | 더 공부할 것
  name: "",                       // 비우면 종류에 따라 "서론", "대지 1", "결론", "더 공부할 것"
  thesis: "",                     // 이 가지에서 말할 한 문장
  items: [Item],
}
Item = {
  id: "i1",
  text: "",                       // 담은 글 또는 직접 쓴 글
  src: "",                        // 출처 표시("IVP 성경주석 · 요 3:16", "《기독교 강요》 p.123", "직접")
  kind: "verse"|"comm"|"lex"|"article"|"page"|"ai"|"memo"|"web"|"own",
  link: null | { t:"ref", bk, ch, v } | { t:"page", book, page } | { t:"study", id } | { t:"url", url },
  note: "",                       // 내 메모(예: "예화로")
  children: [Item],               // 한 단계만(1.1 아래 1.1.1). 손자의 children 은 늘 빈 배열
}
Clip = Item 에서 children 을 뺀 것 + { at: 시각 }   // 자료함 한 칸
```

- 새 설계도의 기본 가지: 서론 1, 대지 3, 결론 1. "더 공부할 것"은 필요할 때 더한다. 서론·결론·더 공부할 것은 하나씩만, 대지는 1~7개.
- 번호는 저장하지 않고 그릴 때 매긴다: 가지 차례 n, 항목 n.m, 그 아래 n.m.k. (서론이 1번이다.)
- 한도: 설계도 한 개에 항목 400개, 글 한 칸 4,000자, 설계도 100개, 자료함 500칸.

## 4. host (앱·웹이 주는 것)

```js
SermonPlan.mount(rootElement, host)   // 화면을 그 자리에 그린다. 돌려주는 것: { open(id), unmount() }
SermonPlan.clipButtonLabel            // "설계도에 담기"

host = {
  kind: "app" | "web",
  // 저장(모두 Promise). 로그인하지 않았으면 host 가 이 기기 저장소로 대신한다.
  listPlans():  [{ id, title, ref, updated }],
  getPlan(id):  Plan | null,
  savePlan(plan): { ok: true },
  deletePlan(id): { ok: true },
  getClips():   [Clip],
  setClips(clips): { ok: true },
  // 바깥 화면과 잇기
  openLink(link),                 // 출처로 가기(절·책 쪽·연구 보고서·웹 주소)
  sendToStudy({ ref, notes }),    // AI 본문연구 시작 화면을 본문·요청 글을 채워 연다
  saveSermon({ title, ref, date, text }): { ok, error },   // 내 설교 자료실에 초안으로 넣기(없으면 null)
  download(filename, text),       // .md 파일로 저장
  copy(text): Promise,            // 클립보드
  toast(message),
  confirm(message): Promise<boolean>,
  defaults: { preacher: "", service: "" },   // 새 설계도에 미리 채울 값
}
```

바깥에서 자료를 담을 때(절·주석·보고서 화면의 [담기] 단추)는 host 쪽 코드가 `SermonPlan.clip(host, clip, target)` 을 부른다.
`target` 이 없으면 자료함에, `{ planId, branchId }` 면 그 가지 끝에 넣는다. `SermonPlan.targets(host)` 는 지금 열어 둔(마지막으로 고친) 설계도의 가지 목록 `[{ planId, branchId, label }]` 을 준다(담기 단추의 "어디에" 차림표용).

## 5. 화면이 해야 할 일

**목록**: 내 설계도 목록(제목·본문·고친 날), 새 설계도, 지우기.

**머리**: 설교 제목, 본문, 설교 정보(일자·장소·예배·설교자, 접어 둠), 보기 바꾸기(순서 보기 | 마인드맵), 내보내기 차림표.

**순서 보기**
- 중심 사상 한 칸, 그 아래 가지들. 가지마다 이름·한 문장·항목 목록.
- 항목: 번호, 글(누르면 그 자리에서 고침), 출처(누르면 `openLink`), 메모, 지우기.
- 차례 바꾸기: 끌어서 같은 가지 안/다른 가지로, 다른 항목의 아래 단계로. 키보드로도(Alt+↑↓ 차례, Tab/Shift+Tab 단계).
- 가지: 대지 더하기·빼기, 대지끼리 차례 바꾸기, "더 공부할 것" 켜고 끄기. 빼기 전에 항목이 있으면 묻는다.
- 직접 쓰기: 가지 아래 [+ 항목].

**자료함**(옆 칸, 접을 수 있음)
- 담아 둔 글 목록(글 앞부분·출처·종류). 찾기 칸.
- 가지로 끌어 놓거나 [넣기 ▾]로 가지를 골라 넣는다. 넣어도 자료함에 남고 "넣음" 표시가 붙는다(같은 글을 두 가지에 쓸 수 있다). 지우기는 따로.
- [직접 쓰기], [붙여넣기](클립보드 글을 한 칸으로).

**마인드맵**
- 가운데 제목·본문, 둘레에 가지. 가지 색은 종류마다 다르다(서론·대지·결론·더 공부할 것·중심 사상).
- 배치 두 가지: 둘레로(시계 방향 = 설교 차례), 좌우로(오른쪽 위→아래, 왼쪽 위→아래).
- 가지 카드에 한 문장과 항목이 보인다. 항목을 끌어 다른 가지로, 자료함에서 끌어 가지로.
- 화면 끌기·휠 확대/축소·"한눈에" 단추. 항목을 누르면 순서 보기와 같은 고침 칸이 뜬다.

**내보내기**
- 글로 복사 / Markdown 파일로 저장 / 내 설교 자료실에 넣기 / AI에게 자료 찾기 요청 / AI에게 원고 초안 요청.
- Markdown 꼴: `# 제목`, 본문·설교 정보 줄, `**중심 사상**`, `## 1. 서론` … 항목은 `1.1 글 (출처)`, 메모는 `  - 메모: …`.
- AI 요청 글은 설계도 전체(Markdown)에 요청 문장을 붙인 것이다. 자료 찾기: "아래 설교 설계도에서 비어 있거나 약한 가지에 넣을 서재 자료(주석·설교·예화)를 가지별로 찾아 출처와 함께 제안해 주세요. 이미 넣은 자료는 되풀이하지 마세요." 원고 초안: "아래 설교 설계도를 따라 설교 원고 초안을 써 주세요. 설계도의 차례와 자료를 지키고, 넣은 자료의 출처를 밝혀 주세요."

**저장**: 고칠 때마다 0.8초 뒤 자동 저장. 저장 중·저장됨·실패(다시 하기)를 작게 보여 준다. 실패해도 고친 내용은 화면에 남는다.

**좁은 화면**(웹 휴대폰 760px 이하): 자료함은 아래 서랍, 마인드맵은 좌우 배치만, 끌기 대신 [옮기기] 차림표.

## 6. plan.js 와 plan-map.js 가 주고받는 것

자료를 고치고 저장하는 일은 모두 `plan.js` 가 한다. `plan-map.js` 는 그리고, 누름·끌어 놓음을 알린다.

```js
// plan-map.js 가 내놓는 것
SermonPlanMap.mount(el, core) -> map      // el: plan.js 가 만든 빈 div. 그 안에 .pl-map 을 그린다
map = {
  refresh(),        // 설계도가 바뀌었다: 다시 그린다(확대·자리·편 카드는 그대로)
  setNarrow(bool),  // 좁은 화면 여부가 바뀌었다
  destroy(),        // 보기를 떠난다: 듣기를 다 풀고 el 을 비운다
}

// plan.js 가 넘겨주는 core
core = {
  plan(),                          // 지금 설계도(읽기만 한다. 고치지 않는다)
  narrow(),                        // 좁은 화면인지
  branchInfo(branchId),            // { no: 2, kindLabel: "대지 1", name: "…"(비면 기본 이름), kind: "point", pt: 1 }
  itemNo(itemId),                  // "2.1" 또는 "2.1.1"
  canAdd(),                        // 항목 한도(400개)에 여유가 있는지
  moveItem(itemId, branchId),      // 항목(아래 단계 포함)을 그 가지 끝으로. plan.js 가 고치고 저장한 뒤 map.refresh() 를 부른다
  putClip(clipId, branchId),       // 자료함의 자료를 그 가지 끝에 복사해 넣는다. 위와 같다
  mountEditor(popEl, itemId, onClose),   // popEl(.pl-pop) 안에 머리와 .pl-edit 을 그린다. [마침]·[취소]·지우기가 끝나면 onClose() 를 부른다.
                                         // 돌려주는 것: { close(commit) } — 맵을 끌거나 확대할 때 map 이 close(true) 를 부른다
  gotoOutline(target),             // { branchId } 또는 { big: true }: 순서 보기로 바꾸고 그 칸에 초점
  toast(message),
}
```

끌어 놓기의 `dataTransfer` 종류는 두 파일이 같이 쓴다: `application/x-pl-item`(항목 id), `application/x-pl-clip`(자료 id). 자료함(`.pl-tray`)은 `plan.js` 가 그리므로, 자료함에서 맵의 가지 카드로 끌어 놓으면 `plan-map.js` 가 `core.putClip` 을 부른다.

## 7. 하지 않는 것

- 여러 사람이 한 설계도를 함께 고치기, 버전 기록, 그림·파일 붙이기.
- 설계도 화면 안에서 AI를 직접 부르기(늘 AI 본문연구 화면을 거친다).
