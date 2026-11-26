# 설교 설계도 — 화면 명세

작성: 2026-11-26. `plan.js`, `plan-map.js` 를 쓰는 사람이 따를 기준이다.
함께 볼 것: `PLAN_DESIGN.md`(할 일·자료 모델·host), `plan-mock.html`(눈으로 보는 견본), `ui/plan.css`(모양).
**견본의 DOM 구조와 클래스 이름을 그대로 쓴다.** 이 문서와 견본이 다르면 견본이 맞다.

## 0. 먼저 알 것

- 모양은 모두 `plan.css` 에 있다. 스크립트에서 색·크기를 인라인으로 넣지 않는다. 인라인 스타일을 쓰는 곳은 마인드맵의 좌표(`left` `top` `width` `height` `transform`)와 뜨는 칸(`.pl-pop`)의 자리뿐이다.
- `plan.css` 는 앱에서는 `style.css` 뒤에, 웹에서는 사이트 스타일 뒤에 불러야 한다. 앱의 `button{}`·`input{}` 기본 규칙을 여기서 다시 고르기 때문이다.
- `.pl-root` 는 놓인 자리의 높이를 다 쓴다(`height:100%`, 안에서만 스크롤). 놓는 쪽(host 화면)이 높이를 정해 준다. 웹에서는 `.pl-root` 에 `pl-web` 을 함께 붙인다(`host.kind === "web"`).
- 앱 바깥 규칙과 부딪히지 않게 `<section>` `<main>` `<header>` 를 쓰지 않는다(앱 `style.css` 에 `section{display:flex…}` 가 있다). 모두 `<div>` 에 `role` 을 준다.
- 아이콘은 인라인 SVG 를 `<svg class="pl-ic" viewBox="0 0 24 24"><path d="…"/></svg>` 꼴로 넣는다. 선 굵기·색은 `.pl-ic` 가 정한다. 견본 맨 위 `<symbol>` 묶음에 쓰는 모양이 다 있다(앱 `icons.js` 와 같은 Lucide 모양). 견본은 `<use>` 로 불렀지만 구현은 path 를 그 자리에 직접 넣는다.
- 한 화면에 채운 단추(`.pl-btn-primary`)는 하나만: 목록의 [새 설계도]. 설계도 화면(순서 보기·마인드맵·자료함)에는 채운 단추가 없다.
- 좁은 화면 규칙은 창 폭이 아니라 **`.pl-root` 의 폭이 760px 이하**일 때 걸린다(CSS `@container`). 스크립트도 같은 기준을 쓴다: `root.clientWidth <= 760` 이면 "좁음"(ResizeObserver 로 살핀다).

## 1. 뿌리와 상태

```html
<div class="pl-root [pl-web]" data-view="list|outline|map" data-tray="open|closed">
  <!-- data-view="list" 일 때 -->  <div class="pl-list">…</div>
  <!-- 그 밖 -->                  <div class="pl-doc" data-id="{plan.id}">…</div>
</div>
```

| 속성 | 값 | 뜻 |
|-|-|-|
| `data-view` | `list` `outline` `map` | 지금 화면. 스크립트가 `.pl-list` 또는 `.pl-doc` 을 그린다 |
| `data-tray` | `open` `closed` | 자료함. 넓은 화면 기본 `open`, 좁은 화면 기본 `closed`. host 저장소가 아니라 화면 안 기억으로만 둔다 |

상태 클래스(모두 스크립트가 붙였다 뗀다).

| 클래스 | 붙는 곳 | 언제 |
|-|-|-|
| `.pl-on` | `.pl-seg > button`, `.pl-ib`, `.pl-map-item`, `.pl-menu > button` | 고른 것(보기·배치), 켜진 것(자료함 단추), 고침 칸이 떠 있는 맵 항목 |
| `.pl-editing` | `.pl-item`, `.pl-clip` | 그 자리에서 고치는 중. 글 대신 `.pl-edit` 이 들어간다 |
| `.pl-used` | `.pl-clip` | 이 설계도의 어느 가지에든 넣은 자료(§7) |
| `.pl-dragging` | `.pl-item`, `.pl-clip`, `.pl-map-item` | 끌고 있는 것(흐리게) |
| `.pl-drop-before` `.pl-drop-after` `.pl-drop-child` | `.pl-item` | 놓을 자리: 그 항목 앞 / 뒤 / 아래 단계 |
| `.pl-drop` | `.pl-branch`, `.pl-map-node` | 그 가지 끝에 놓는 중(빈 가지 포함) |
| `.pl-open` | `.pl-map-node` | 맵에서 "더 보기"로 항목을 다 편 가지 |
| `.pl-panning` | `.pl-map-view` | 맵 바탕을 끌어 움직이는 중 |
| `.pl-over` | `.pl-count` | 글자 수가 한도를 넘음 |
| `.pl-up` `.pl-left` | `.pl-menu` | 차림표를 위로 / 왼쪽 맞춤으로 연다(§2.1) |

가지 색: 가지에 딸린 요소에 `data-kind="intro|point|outro|more"` 를 달고, 대지는 `data-pt="1"`…(대지끼리의 차례, 1부터)를 함께 단다. 그 안에서 `--pl-c`(글자·선)와 `--pl-c-soft`(옅은 바탕)가 그 가지 색이 된다. 중심 사상은 `data-kind="big"`. 달아야 하는 곳: `.pl-branch`, `.pl-map-node`, `.pl-map-line`, `.pl-pop`, 차림표의 가지 줄(`.pl-menu > button`). 대지 색은 1·4·7 / 2·5 / 3·6 이 같은 빛이다.

주의: `.pl-item` 과 `.pl-clip` 의 `data-kind` 는 **자료 종류**(`verse` `comm` …)다. 값이 겹치지 않으니 그대로 둔다.

## 2. 공통 부품

| 부품 | 꼴 | 쓰임 |
|-|-|-|
| 단추 | `button.pl-btn` (+ `pl-btn-primary` `pl-btn-quiet` `pl-btn-danger` `pl-btn-sm`) | 글자 단추. 기본은 가는 테두리 |
| 아이콘 단추 | `button.pl-ib` (+ `pl-ib-danger`) | 28px(좁은 화면·터치 40px). `aria-label` 과 `title` 필수 |
| 글자 단추 | `button.pl-link` | "다시 하기", "출처 열기" |
| 고르기 | `div.pl-seg > button` | 보기(순서 보기/마인드맵), 배치(둘레로/좌우로). 고른 것에 `.pl-on` |
| 입력칸 | `input.pl-input`, `textarea.pl-input` | 테두리 있는 칸 |
| 글 같은 칸 | `input.pl-bare`, `textarea.pl-bare` | 제목·본문·중심 사상·가지 이름·한 문장. 평소엔 글, 들어가면 칸 |
| 라벨 묶음 | `label.pl-field > span + .pl-input` | 설교 정보, 고침 칸 |
| 종류 표시 | `span.pl-kind` | 자료 종류 글귀(§12.5) |
| 색 점 | `i.pl-dot` | 차림표의 가지 줄 앞 |
| 차림표 | `details.pl-menu-wrap > summary + div.pl-menu` | §2.1 |
| 빈 상태 | `div.pl-empty > svg.pl-ic + p (+ button)` | 목록이 비었을 때 |

`textarea.pl-bare` 와 `textarea.pl-input` 은 내용만큼 자란다. CSS `field-sizing:content` 를 쓰되, 이를 모르는 브라우저를 위해 입력할 때마다 `style.height = "auto"; style.height = scrollHeight + "px"` 로 맞춘다.

### 2.1 차림표(내보내기·넣기·옮기기)

```html
<details class="pl-menu-wrap pl-export|pl-put|pl-move">
  <summary class="pl-btn | pl-ib" aria-label="…">…<svg class="pl-ic pl-chev">…</svg></summary>
  <div class="pl-menu" role="menu">
    <div class="pl-menu-label">묶음 이름</div>
    <button type="button" role="menuitem" data-act="…">…<span>글귀</span></button>
    <button type="button" role="menuitem" data-branch="b2" data-kind="point" data-pt="1"><i class="pl-dot"></i><span>2. 가지 이름</span></button>
    <div class="pl-menu-sep"></div>
    <div class="pl-menu-note">작은 안내</div>
  </div>
</details>
```

- `div.pl-menu` 는 **열 때 만들어 넣고 닫을 때 뺀다**(견본에서 닫힌 차림표는 `summary` 만 있다). 항목마다 미리 만들어 두지 않는다.
- 한 번에 하나만 연다. 바깥을 누르거나 Esc, 항목을 고르면 닫는다(`details.open = false`). Esc 로 닫으면 초점을 `summary` 로 돌린다.
- 열고 나서 자리를 본다: 차림표 아래 끝이 스크롤 영역(`.pl-outline-scroll`, `.pl-clips`, `.pl-map`) 아래로 넘치면 `.pl-up` 을, 왼쪽이 `.pl-root` 밖으로 나가면 `.pl-left` 를 붙인다.
- 가지 줄의 글귀는 `"{가지 차례}. {이름 또는 기본 이름}"`. 지금 있는 가지(옮기기에서는 그 항목이 든 가지)는 `disabled`.
- 키보드: `summary` 에서 Enter/Space/↓ 로 열고 첫 항목에 초점, ↑↓ 로 오가고 Home/End, Enter 로 고름.

## 4. 설계도 목록 (`data-view="list"`)

```html
<div class="pl-list"><div class="pl-list-in">
  <div class="pl-list-head">
    <div class="pl-grow">
      <h1 class="pl-list-title">설교 설계도</h1>
      <p class="pl-list-sub">찾은 자료를 설교 차례대로 엮습니다.</p>
    </div>
    <button type="button" class="pl-btn pl-btn-primary pl-new">＋아이콘 새 설계도</button>
  </div>
  <ul class="pl-plans">
    <li class="pl-plan" data-id="{id}">
      <button type="button" class="pl-plan-open">
        <span class="pl-plan-title">{제목 | 제목 없는 설계도}</span>
        <span class="pl-plan-meta"><span class="pl-plan-ref">{본문 | 본문 없음}</span><span class="pl-plan-when">{고친 때} 고침</span></span>
      </button>
      <button type="button" class="pl-ib pl-ib-danger pl-plan-del" aria-label="설계도 지우기" title="지우기">휴지통</button>
    </li>
  </ul>
  <p class="pl-list-foot">설계도 {n}개</p>
</div></div>
```

- 차례는 `updated` 가 새것부터. `.pl-plan-open` 을 누르면 그 설계도를 `outline` 으로 연다.
- 고친 때: 오늘이면 `오늘 14:20`, 올해면 `11월 20일`, 그 전이면 `2025년 3월 2일`.
- [새 설계도]: 묻지 않고 바로 만든다(기본 가지 서론 1·대지 3·결론 1, `host.defaults` 채움). 열고 나서 제목 칸에 초점. 100개가 차 있으면 만들지 않고 알린다(§12.6).
- 지우기: `host.confirm` 으로 묻는다(§12.6). 지우기 단추는 줄에 올리거나 초점이 들어올 때만 보인다(터치·좁은 화면은 늘 보임).
- **하나도 없을 때**: `.pl-list-head` 의 [새 설계도]와 `.pl-plans`·`.pl-list-foot` 을 빼고, 그 자리에 `.pl-empty`(아이콘 + 글 + `button.pl-btn.pl-btn-primary.pl-new`)를 둔다. 채운 단추가 둘이 되지 않게 한다.
- 목록을 불러오는 동안에는 `.pl-list-foot` 에 "불러오는 중…" 만 둔다. 실패하면 "설계도를 불러오지 못했습니다." 와 `button.pl-link` "다시 하기".

## 5. 설계도 화면 뼈대와 머리

```html
<div class="pl-doc" data-id="{id}">
  <div class="pl-head">
    <div class="pl-head-row">
      <button type="button" class="pl-ib pl-back" aria-label="설계도 목록으로" title="설계도 목록">‹</button>
      <input class="pl-bare pl-title" type="text" placeholder="설교 제목" aria-label="설교 제목" maxlength="120">
      <span class="pl-save" data-state="saved|saving|failed" role="status">…</span>
      <div class="pl-seg pl-views" role="tablist" aria-label="보기">
        <button type="button" role="tab" data-view="outline" class="pl-on" aria-selected="true">순서 보기</button>
        <button type="button" role="tab" data-view="map" aria-selected="false">마인드맵</button>
      </div>
      <details class="pl-menu-wrap pl-export"><summary class="pl-btn">공유아이콘<span>내보내기</span>꺾쇠</summary></details>
      <button type="button" class="pl-ib pl-tray-toggle" aria-pressed="true|false" aria-label="자료함" title="자료함 접기|자료함 펴기">서랍아이콘</button>
    </div>
    <div class="pl-head-sub">
      <label class="pl-ref-field">책아이콘<input class="pl-bare pl-ref" type="text" placeholder="본문  예: 요 15:1-8" aria-label="설교 본문"></label>
      <button type="button" class="pl-info-toggle" aria-expanded="false" aria-controls="{info id}">설교 정보<span class="pl-info-sum">{간추림}</span>꺾쇠</button>
    </div>
    <div class="pl-info" id="{info id}" hidden>
      <label class="pl-field"><span>일자</span><input class="pl-input" type="date" data-info="date"></label>
      <label class="pl-field"><span>예배</span><input class="pl-input" type="text" data-info="service"></label>
      <label class="pl-field"><span>장소</span><input class="pl-input" type="text" data-info="place" placeholder="예: 본당"></label>
      <label class="pl-field"><span>설교자</span><input class="pl-input" type="text" data-info="preacher" placeholder="이름"></label>
    </div>
  </div>
  <div class="pl-body">
    <div class="pl-main"> <!-- 순서 보기(.pl-outline-scroll) 또는 마인드맵(.pl-map) 하나 --> </div>
    <div class="pl-veil"></div>
    <div class="pl-tray" role="complementary" aria-label="자료함">…</div>
  </div>
</div>
```

- 설교 정보는 접어 둔 채로 시작한다. `.pl-info-toggle` 이 `hidden` 과 `aria-expanded` 를 바꾼다. `.pl-info-sum` 은 채운 값만 ` · ` 로 이은 것(`11월 27일 · 금요기도회`), 좁은 화면에서는 일자만. 아무것도 없으면 `적어 두기`.
- 보기를 바꾸면 `.pl-root[data-view]`, 두 단추의 `.pl-on`·`aria-selected` 를 바꾸고 `.pl-main` 안을 갈아 끼운다. 자료함·머리는 그대로 둔다.
- `.pl-tray-toggle` 은 `data-tray` 를 뒤집고 자신에게 `.pl-on`·`aria-pressed` 를 맞춘다. 좁은 화면에서는 이 단추가 숨겨지고 자료함 머리가 그 일을 한다(§8).
- `.pl-export > summary` 안의 글자는 `<span>` 으로 싼다(좁은 화면에서 아이콘만 남는다). `aria-label="내보내기"` 를 `summary` 에 둔다.

### 5.1 저장 상태 `.pl-save`

| `data-state` | 안 | 모양 |
|-|-|-|
| `saved` | 체크 아이콘 + `저장됨` | 옅은 글자, 아이콘만 초록 |
| `saving` | `저장 중…` | 옅은 글자(돌아가는 그림 없음) |
| `failed` | `저장하지 못했습니다` + `<button class="pl-link pl-save-retry">다시 하기</button>` | 붉은 글자 |

고친 뒤 0.8초 동안은 그대로 두었다가 저장을 시작하며 `saving` 으로 바꾼다. 실패해도 화면의 내용은 그대로 두고, [다시 하기]나 다음 고침 때 다시 저장한다. 저장이 끝나지 않았는데 목록으로 가려 하면 먼저 저장을 마친다(실패하면 §12.6 의 물음).

### 5.2 내보내기 차림표

| `data-act` | 아이콘 | 글귀 | 하는 일 |
|-|-|-|-|
| `copy` | copy | 글로 복사 | Markdown 을 `host.copy` |
| `md` | file-text | Markdown 파일로 저장 | `host.download("{제목}.md", …)` |
| `sermon` | 책꽂이 | 내 설교 자료실에 넣기 | `host.saveSermon`. host 에 없으면(null) 이 줄을 뺀다 |
| — | | (구분선, 묶음 이름 `AI 본문연구로 보내기`) | |
| `ai-find` | search | 빈 가지에 넣을 자료 찾기 | `host.sendToStudy` |
| `ai-draft` | sparkles | 원고 초안 쓰기 | `host.sendToStudy` |
| — | | (안내) `연구 화면이 열립니다. 거기서 시작을 눌러야 진행됩니다.` | |

## 6. 순서 보기

```html
<div class="pl-outline-scroll"><div class="pl-outline">
  <div class="pl-big" data-kind="big">
    <label class="pl-big-label" for="{id}">중심 사상</label>
    <textarea class="pl-bare pl-big-text" id="{id}" rows="1" placeholder="이 설교가 말하려는 한 문장" maxlength="300"></textarea>
  </div>

  <div class="pl-branch" data-kind="point" data-pt="1" data-id="{branch.id}">
    <div class="pl-branch-head">
      <span class="pl-branch-no">2</span>
      <span class="pl-branch-kind">대지 1</span>
      <input class="pl-bare pl-branch-name" type="text" placeholder="이름을 붙여도 됩니다" aria-label="대지 1 이름" maxlength="80">
      <span class="pl-branch-tools">
        <button type="button" class="pl-ib pl-branch-up" aria-label="대지를 앞으로" title="앞으로">↑</button>
        <button type="button" class="pl-ib pl-branch-down" aria-label="대지를 뒤로" title="뒤로">↓</button>
        <button type="button" class="pl-ib pl-ib-danger pl-branch-del" aria-label="대지 빼기" title="대지 빼기">휴지통</button>
      </span>
    </div>
    <textarea class="pl-bare pl-thesis" rows="1" placeholder="이 가지에서 말할 한 문장" aria-label="대지 1에서 말할 한 문장" maxlength="300"></textarea>
    <ol class="pl-items"> … </ol>
    <p class="pl-branch-empty">아직 넣은 자료가 없습니다. …</p>   <!-- 항목이 없을 때만 -->
    <button type="button" class="pl-add">＋아이콘 항목</button>
  </div>
  …
  <div class="pl-outline-foot">
    <button type="button" class="pl-btn pl-btn-quiet pl-add-point">＋ 대지 더하기</button>
    <button type="button" class="pl-btn pl-btn-quiet pl-toggle-more" aria-pressed="false">＋ 더 공부할 것 두기</button>
  </div>
</div></div>
```

### 6.1 가지

- `.pl-branch-no` 는 가지 차례(서론이 1). `.pl-branch-kind` 는 `서론` / `대지 {n}` / `결론` / `더 공부할 것`.
- `.pl-branch-tools`: 대지만 ↑ ↓ 빼기 셋을 둔다. 첫 대지의 ↑, 끝 대지의 ↓ 는 `disabled`. 대지가 하나뿐이면 빼기도 `disabled`. "더 공부할 것"은 빼기 하나(`aria-label="더 공부할 것 빼기"`). 서론·결론은 빈 `span` 만 둔다.
- 빼기: 항목이 있으면 `host.confirm`(§12.6), 없으면 바로 뺀다.
- [대지 더하기]: 끝 대지 뒤(결론 앞)에 넣고 그 이름 칸에 초점. 대지가 7개면 `disabled`, `title="대지는 7개까지 둘 수 있습니다"`.
- [더 공부할 것 두기]: 맨 끝에 가지를 더한다. 이미 있으면 글귀를 `더 공부할 것 빼기` 로, `aria-pressed="true"` 로, 아이콘을 minus 로 바꾼다.
- 항목이 없으면 `<ol class="pl-items">` 는 비워 두고 `.pl-branch-empty` 를 넣는다. 좁은 화면에서는 글귀가 다르다(§12.3).

### 6.2 항목

```html
<li class="pl-item" data-id="{item.id}" data-kind="comm">
  <div class="pl-item-row" draggable="true">
    <button type="button" class="pl-grip" tabindex="-1" aria-hidden="true">손잡이</button>
    <span class="pl-item-no">2.1</span>
    <div class="pl-item-body">
      <div class="pl-item-text" tabindex="0" role="button" aria-label="2.1 고치기">{item.text}</div>
      <div class="pl-item-meta">
        <span class="pl-kind">주석</span>
        <button type="button" class="pl-src" title="출처 열기">{item.src}</button>   <!-- link 가 없으면 <span class="pl-src"> -->
        <span class="pl-note">연필아이콘{item.note}</span>                          <!-- note 가 있을 때만 -->
      </div>
    </div>
    <span class="pl-item-tools">
      <details class="pl-menu-wrap pl-move"><summary class="pl-ib" aria-label="옮기기" title="옮기기">위아래화살표</summary></details>
      <button type="button" class="pl-ib pl-ib-danger pl-item-del" aria-label="항목 지우기" title="지우기">휴지통</button>
    </span>
  </div>
  <ol class="pl-items pl-sub"> <li class="pl-item">…</li> </ol>   <!-- 아래 단계가 있을 때만. 한 단계까지 -->
</li>
```

- 번호는 그릴 때 매긴다: `{가지}.{항목}`, 아래 단계는 `{가지}.{항목}.{차례}`.
- 글은 `textContent` 로 넣는다(줄바꿈은 CSS 가 살린다). HTML 로 넣지 않는다.
- `kind` 가 `own` 이고 `src` 가 비었으면 `.pl-kind` "직접" 만 두고 `.pl-src` 는 뺀다.
- `.pl-item-text` 를 누르거나 초점에서 Enter/F2 → 고치기(§6.4). 글을 긁어 고르는 중(`getSelection()` 이 비지 않음)이면 고치기로 가지 않는다.
- `.pl-src`(단추)를 누르면 `host.openLink(item.link)`.
- 지우기: 아래 단계가 있으면 묻고(§12.6), 없으면 바로 지운 뒤 `host.toast("항목을 지웠습니다")`. 지운 뒤 초점은 다음 항목(없으면 앞 항목, 그것도 없으면 `.pl-add`).
- 손잡이·도구 단추는 줄에 올리거나 초점이 들어왔을 때만 보인다(CSS). 터치·좁은 화면에서는 손잡이가 없고 도구가 늘 보인다.

### 6.3 [옮기기] 차림표 (끌기를 대신하는 길. 넓은 화면에도 둔다)

| `data-act` / 속성 | 글귀 | 못 쓰는 때(`disabled`) |
|-|-|-|
| `up` | 위로 | 같은 단계의 맨 앞 |
| `down` | 아래로 | 같은 단계의 맨 끝 |
| `in` | 윗항목 아래 단계로 | 앞에 형제가 없음 / 이미 아래 단계 / 자신에게 아래 단계가 있음 |
| `out` | 한 단계 밖으로 | 이미 맨 윗단계 |
| (묶음 이름) | 다른 가지로 | |
| `data-branch` | `{n}. {가지 이름}` (색 점) | 지금 든 가지 |
| `del` (`.pl-danger`) | 지우기 | — |

다른 가지로 보내면 그 가지의 끝에 맨 윗단계로 들어간다(아래 단계는 함께 간다). 옮긴 뒤 초점은 옮겨진 항목의 `.pl-item-text`.

### 6.4 고치는 중 (`.pl-item.pl-editing`)

`.pl-item-body` 안을 아래로 갈아 끼우고, `.pl-item-row` 의 `draggable` 을 뗀다. 한 번에 한 항목만 고친다(다른 항목을 열면 앞의 것은 [마침]과 같이 닫는다).

```html
<div class="pl-edit">
  <textarea class="pl-input pl-edit-text" aria-label="글" maxlength="4000"></textarea>
  <div class="pl-edit-fields">
    <label class="pl-field"><span>출처</span><input class="pl-input pl-edit-src" type="text" maxlength="200"></label>
    <label class="pl-field"><span>메모</span><input class="pl-input pl-edit-note" type="text" maxlength="200" placeholder="예: 예화로"></label>
  </div>
  <div class="pl-edit-actions">
    <span class="pl-count">44 / 4,000자</span>
    <span class="pl-grow"></span>
    <button type="button" class="pl-btn pl-btn-quiet pl-edit-cancel">취소</button>
    <button type="button" class="pl-btn pl-edit-done">마침</button>
  </div>
</div>
```

- 열면 글 칸에 초점, 커서는 끝. 글자 수는 입력할 때마다 고치고 3,800자를 넘으면 그대로, 4,000자에 닿으면 `.pl-over`.
- 닫기: [마침], Ctrl+Enter, 칸 밖을 누름 → 고친 것을 둔다. [취소], Esc → 버린다. 글이 비면 [마침]은 그 항목을 지운다(새로 쓴 빈 항목은 조용히, 있던 항목은 §12.6 의 물음 없이 지우고 알림 "항목을 지웠습니다").
- [＋ 항목]: 가지 끝에 `kind:"own"`, `src:"직접"` 인 빈 항목을 만들어 바로 고치는 중으로 연다. 고치는 중에 Enter 는 줄바꿈이다.
- 출처를 고쳐도 `link` 는 그대로 둔다.

## 7. 자료함

```html
<div class="pl-tray" role="complementary" aria-label="자료함">
  <div class="pl-tray-head">
    <b class="pl-tray-title">자료함</b><span class="pl-tray-n">{n}</span>
    <span class="pl-grow"></span>
    <button type="button" class="pl-ib pl-tray-close" aria-label="자료함 접기" title="접기">
      <svg class="pl-ic pl-when-wide">x</svg><svg class="pl-ic pl-when-narrow">chevron-down</svg>
    </button>
  </div>
  <div class="pl-tray-tools">
    <label class="pl-search">돋보기<input class="pl-input pl-tray-q" type="search" placeholder="자료함에서 찾기" aria-label="자료함에서 찾기"></label>
    <div class="pl-tray-acts">
      <button type="button" class="pl-btn pl-btn-quiet pl-btn-sm pl-clip-new">연필 직접 쓰기</button>
      <button type="button" class="pl-btn pl-btn-quiet pl-btn-sm pl-clip-paste">복사아이콘 붙여넣기</button>
    </div>
  </div>
  <ul class="pl-clips">
    <li class="pl-clip [pl-used]" data-id="{clip.id}" data-kind="verse" draggable="true">
      <p class="pl-clip-text">{clip.text}</p>
      <div class="pl-clip-meta"><span class="pl-kind">성경</span><span class="pl-clip-src">{clip.src}</span></div>
      <div class="pl-clip-foot">
        <span class="pl-used-mark">체크 넣음 · 대지 1</span>
        <span class="pl-grow"></span>
        <details class="pl-menu-wrap pl-put"><summary class="pl-btn pl-btn-sm">넣기 꺾쇠</summary></details>
        <button type="button" class="pl-ib pl-ib-danger pl-clip-del" aria-label="자료함에서 지우기" title="자료함에서 지우기">휴지통</button>
      </div>
    </li>
  </ul>
  <p class="pl-tray-empty" hidden>…</p>
</div>
```

- 차례는 `at` 이 새것부터. 글은 세 줄까지만 보인다(CSS). 전체는 `title` 에 넣지 않는다(길다). 줄을 두 번 누르면 그 자리에서 고친다(`.pl-clip.pl-editing`, 안에 §6.4 의 `.pl-edit`).
- **넣음 표시**: 지금 연 설계도의 항목 가운데 `text` 와 `src` 가 같은 것이 있으면 `.pl-used`. `.pl-used-mark` 의 글귀는 넣은 가지가 하나면 `넣음 · {가지 기본 이름}`, 둘 이상이면 `넣음 · {n}곳`. 표시는 늘 DOM 에 두고 CSS 가 `.pl-used` 일 때만 보인다. 넣어도 자료함에서 빠지지 않는다.
- [넣기]: 차림표에 묶음 이름 `어느 가지에 넣을까요` 와 가지 줄들. 고르면 그 가지 끝에 넣고 `host.toast("{가지 이름}에 넣었습니다")`. 이미 든 가지도 고를 수 있다(막지 않는다).
- 찾기: 입력할 때마다 `text`·`src` 에서 찾아 맞는 줄만 남기고, 맞은 글자를 `<mark>` 로 싼다. 없으면 `.pl-tray-empty`(§12.4). Esc 로 칸을 비운다.
- [직접 쓰기]: 목록 맨 위에 빈 `.pl-clip.pl-editing` 을 연다(`kind:"memo"`, `src:"직접"`). [붙여넣기]: `navigator.clipboard.readText()` 로 읽어 한 칸으로 넣는다(`kind:"memo"`, `src:"붙여넣기"`). 비었거나 읽지 못하면 §12.6 의 알림.
- 지우기는 묻지 않고 지운 뒤 알린다(`자료함에서 지웠습니다`). 설계도에 넣은 항목은 그대로 남는다.
- 500칸이 차면 [직접 쓰기]·[붙여넣기]를 `disabled` 로 하고 `title="자료함이 가득 찼습니다(500칸)"`.

## 8. 좁은 화면 (`.pl-root` 폭 760px 이하)

CSS 가 하는 일: 머리가 두 줄로 접히고(제목 한 줄, 그 아래 저장 상태·보기·내보내기), 내보내기는 아이콘만, 자료함 단추와 끌기 손잡이·항목의 지우기 단추가 숨고, 누르는 자리가 40px 이 되고, 자료함이 아래 서랍이 된다.

스크립트가 할 일.

- 자료함 서랍: 닫혀 있어도 머리(48px)는 화면 아래에 보인다. **`.pl-tray-head` 어디를 눌러도** `data-tray` 를 뒤집는다(넓은 화면에서는 `.pl-tray-close` 만). 열리면 `.pl-veil` 이 보이고, 그것을 누르거나 Esc 면 닫는다. `.pl-tray-close` 의 `aria-label` 을 `자료함 펴기`/`자료함 접기` 로, `aria-expanded` 를 맞춘다.
- 끌어 놓기를 쓰지 않는다(`draggable` 을 달지 않는다). 항목은 [옮기기] 차림표로, 자료는 [넣기] 차림표로 옮긴다. [옮기기] 차림표 끝의 `지우기` 가 항목 지우기를 맡는다.
- 자료함에서 [넣기]로 넣으면 서랍을 닫지 않는다(여러 개를 이어 넣을 수 있게).
- 마인드맵은 "좌우로" 배치만 쓴다(배치 고르기는 CSS 가 숨긴다). 저장해 둔 배치가 "둘레로"여도 좁은 동안은 "좌우로"로 그린다.
- 폭이 760px 을 넘나들면 다시 그린다. 고치는 중인 칸은 닫지 않는다.

## 9. 마인드맵 (`plan-map.js`)

```html
<div class="pl-map" data-layout="ring|sides">
  <div class="pl-map-view" tabindex="0" aria-label="마인드맵. 끌어서 움직이고 휠로 확대합니다.">
    <div class="pl-map-canvas" style="width:{W}px;height:{H}px;transform:translate({tx}px,{ty}px) scale({s})">
      <svg class="pl-map-lines" style="width:{W}px;height:{H}px" aria-hidden="true">
        <path class="pl-map-line" data-kind="point" data-pt="1" data-to="{branch.id}" d="M… C…"/>
      </svg>
      <div class="pl-map-center" style="left:{x}px;top:{y}px">
        <div class="pl-map-title">{제목 | 제목 없는 설계도}</div>
        <div class="pl-map-ref">{본문}</div>
        <div class="pl-map-big" data-kind="big"><span class="pl-map-big-label">중심 사상</span>{big}</div>   <!-- big 이 비면 뺀다 -->
      </div>
      <div class="pl-map-node [pl-open] [pl-drop]" data-kind="point" data-pt="1" data-id="{branch.id}" style="left:{x}px;top:{y}px">
        <div class="pl-map-node-head"><span class="pl-map-no">2</span><span class="pl-map-kind">대지 1</span><b class="pl-map-name">{name}</b></div>
        <p class="pl-map-thesis">{thesis}</p>                                   <!-- 비면 뺀다 -->
        <ul class="pl-map-items">
          <li class="pl-map-item [pl-sub] [pl-on]" data-id="{item.id}" draggable="true" tabindex="0"><span class="pl-item-no">2.1</span><span class="pl-map-item-text">{text}</span></li>
        </ul>
        <button type="button" class="pl-map-more" aria-expanded="false">3개 더 보기</button>   <!-- 넘칠 때만 -->
        <p class="pl-map-node-empty">비어 있습니다</p>                             <!-- 항목이 없을 때만 -->
      </div>
    </div>
  </div>
  <div class="pl-pop" …>…</div>                                                 <!-- 항목을 눌렀을 때만 -->
  <div class="pl-map-bar pl-map-bar-layout">
    <div class="pl-seg pl-layouts" role="radiogroup" aria-label="배치">
      <button type="button" role="radio" data-layout="ring" class="pl-on" aria-checked="true">둘레로</button>
      <button type="button" role="radio" data-layout="sides" aria-checked="false">좌우로</button>
    </div>
  </div>
  <div class="pl-map-bar pl-map-bar-zoom">
    <button type="button" class="pl-ib pl-zoom-out" aria-label="작게" title="작게">−</button>
    <span class="pl-zoom-val" aria-live="polite">100%</span>
    <button type="button" class="pl-ib pl-zoom-in" aria-label="크게" title="크게">＋</button>
    <button type="button" class="pl-btn pl-btn-quiet pl-btn-sm pl-zoom-fit">한눈에</button>
  </div>
</div>
```

`SermonPlanMap` 이 `plan.js` 와 주고받을 것(이름은 구현자가 정해도 되지만 구실은 이대로): 그리기(plan, 좁음 여부), 항목 누름·항목 옮김·자료 넣음을 알리는 콜백, 다시 그리기. 자료를 고치는 일은 모두 `plan.js` 가 한다.

### 9.1 크기

| 것 | 값 |
|-|-|
| 가운데 카드 | 폭 280px, 높이는 내용대로(그린 뒤 `offsetHeight` 로 잰다) |
| 가지 카드 | 폭 260px, 높이는 내용대로(잰다) |
| 항목 줄 | 두 줄까지 보이고 넘치면 말줄임(CSS). 아래 단계는 `.pl-sub` 로 들여 쓴다 |
| 캔버스 여백 | 모든 카드를 둘러싼 네모에 사방 40px |

**항목 수**: 가지 카드에는 줄을 **4개까지**(윗단계와 아래 단계를 설계도 차례대로 편 것) 보인다. 더 있으면 4개만 그리고 `.pl-map-more` 에 `{남은 수}개 더 보기`. 누르면 그 카드에 `.pl-open` 을 붙이고 모든 줄을 그린 뒤(카드 안 목록은 340px 을 넘으면 그 안에서 스크롤) 단추 글귀를 `접기` 로, `aria-expanded="true"` 로 바꾸고 배치를 다시 한다. 편 카드는 보기를 떠날 때까지 기억한다.

### 9.2 자리 잡기

차례: ① 카드를 모두 그리고(자리는 아직 0,0) 높이를 잰다 → ② 아래 규칙으로 가운데 카드의 **가운데를 원점 (0,0)** 으로 하는 좌표를 낸다 → ③ 모든 네모의 가장 왼쪽·위쪽이 (40,40)이 되게 한꺼번에 민다 → ④ `left`/`top`(카드의 왼쪽 위 모서리), 캔버스 `W`·`H`, 선을 넣는다. 가지 수를 `n`, 가지 `i`(0부터, 설교 차례)의 높이를 `h_i`, 가운데 카드의 폭·높이를 `cw=280`, `ch` 라 한다.

**둘레로(`ring`)** — 시계 방향이 설교 차례, 오른쪽 위에서 시작한다.

1. 가지 `i` 의 각도: `θ_i = −90° + (i + 0.5) × 360° / n` (0° 는 오른쪽, 시계 방향으로 커진다. 화면 좌표라 y 는 아래로 간다).
2. 타원 반지름 `rx = 440k`, `ry = 310k`, `k` 는 1에서 시작한다. 카드의 **가운데**를 `(rx·cos θ_i, ry·sin θ_i)` 에 둔다. 네모는 거기서 폭 260·높이 `h_i` 의 절반씩.
3. 겹침 검사: 가지 카드끼리 사이가 24px 보다 좁거나, 가지 카드와 가운데 카드 사이가 40px 보다 좁으면 `k` 를 0.06 올려 2번부터 다시 한다. `k` 는 2.5 까지(그래도 겹치면 그대로 둔다).
4. 가지가 1개면 아래(90°), 2개면 오른쪽·왼쪽이 된다. 식 그대로다.

**좌우로(`sides`)** — 오른쪽 위에서 아래로, 이어서 왼쪽 위에서 아래로.

1. 오른쪽에 앞의 `r = ceil(n / 2)` 개, 왼쪽에 나머지.
2. 오른쪽 줄 카드의 왼쪽 모서리 x = `cw/2 + 110`. 왼쪽 줄 카드의 오른쪽 모서리 x = `−(cw/2 + 110)`.
3. 한 줄 안에서는 위에서 아래로 쌓고 사이는 20px. 줄 전체 높이(카드 높이 합 + 사이)의 가운데가 y = 0 에 오게 한다. 줄 방향으로만 쌓으므로 겹치지 않는다.

카드를 펴거나(`.pl-open`) 내용이 바뀌어 높이가 달라지면 ①부터 다시 한다. 다시 할 때 화면이 튀지 않게, 가운데 카드가 화면에서 같은 자리에 있도록 `tx`·`ty` 를 고친다.

### 9.3 연결선

가지마다 `path.pl-map-line` 하나. `data-kind`/`data-pt` 로 색이 정해진다. 선은 카드 아래에 깔린다(`svg` 가 카드보다 먼저 온다).

먼저 가지 카드와 가운데 카드의 **가로 틈** `gx` 를 잰다: 카드가 오른쪽에 있으면 `카드 왼쪽 − cw/2`, 왼쪽에 있으면 `−cw/2 − 카드 오른쪽`.

- `gx ≥ 40` → **옆으로 잇기**. 시작 `(x1, y1)` = 가운데 카드의 그쪽 옆 모서리 가운데 `(±cw/2, 0)`. 끝 `(x2, y2)` = 가지 카드의 안쪽 옆 모서리에서 **위에서 22px**(머리 줄 높이). `d = (x2 − x1) / 2` 일 때
  `M x1 y1 C (x1+d) y1, (x2−d) y2, x2 y2`
- 그 밖(카드가 가운데 카드의 위나 아래에 있다) → **위아래로 잇기**. 끝 `(x2, y2)` = 가지 카드의 가운데 x, 아래에 있으면 카드 윗변·위에 있으면 카드 아랫변. 시작 `x1 = clamp(x2 × 0.35, −cw/2 + 24, cw/2 − 24)`, `y1 = ±ch/2`(그쪽 변). `d = (y2 − y1) / 2` 일 때
  `M x1 y1 C x1 (y1+d), x2 (y2−d), x2 y2`

좌표는 9.2 의 ③(40px 밀기)을 한 뒤의 값으로 쓰고 정수로 둥글린다. "좌우로"는 늘 옆으로 잇기가 된다.

### 9.4 움직이기·확대

- 확대 범위 **25% ~ 200%**. `.pl-zoom-val` 에 `Math.round(s × 100) + "%"`.
- 휠: 한 칸에 ×1.1 / ÷1.1, **포인터 자리를 축으로**(포인터 아래 점이 그대로 있게 `tx`·`ty` 를 고친다). 터치는 두 손가락 벌리기.
- [작게]·[크게]: 10% 씩, 보는 자리의 가운데를 축으로.
- 바탕 끌기: `.pl-map-view` 의 빈 곳(카드 밖)을 잡아 끌면 `tx`·`ty` 가 바뀐다. 끄는 동안 `.pl-panning`. 카드 위에서 시작한 끌기는 화면을 움직이지 않는다.
- [한눈에]: `s = min(1, (보는 폭 − 32) / W, (보는 높이 − 32) / H)`(25% 아래로는 내리지 않는다), 가운데로.
- 처음 열 때: 넓은 화면은 [한눈에]와 같다. 좁은 화면은 **가운데 카드와 오른쪽 줄이 들어오게** 맞춘다: `s = clamp((보는 폭 − 24) / (cw + 110 + 260), 0.25, 1)`, 가운데 카드의 왼쪽이 화면 왼쪽에서 12px, 세로는 가운데. 왼쪽 줄은 밀어서 본다. 좁은 화면에서는 보는 높이에서 자료함 머리 48px 을 뺀다.
- 배치를 바꾸면 [한눈에]로 다시 맞춘다. 고른 배치는 설계도가 아니라 화면 기억으로 둔다(host 에 저장할 자리가 없다).
- 확대·이동 값은 `transform` 한 곳에만 쓴다. `transform-origin` 은 `0 0`(CSS).

### 9.5 누르기·고침 칸

- 항목(`.pl-map-item`)을 누르거나 초점에서 Enter → 그 항목에 `.pl-on`, `.pl-map` 바로 아래에 `.pl-pop` 을 띄운다(캔버스 밖이라 확대의 영향을 받지 않는다).

```html
<div class="pl-pop" data-kind="point" data-pt="2" role="dialog" aria-label="항목 고치기" style="left:{x}px;top:{y}px">
  <div class="pl-pop-head"><b>3.3</b><span>대지 2</span><span class="pl-grow"></span>
    <button type="button" class="pl-ib pl-ib-danger pl-item-del" aria-label="항목 지우기" title="지우기">휴지통</button></div>
  <div class="pl-edit"> …§6.4 와 같다. 다만 .pl-edit-actions 의 맨 앞은 글자 수 대신
    <button type="button" class="pl-link pl-edit-open">출처 열기</button> (link 가 있을 때만)… </div>
</div>
```

- 자리: 항목의 화면 네모 아래 6px, 왼쪽을 맞춘다. `.pl-map` 밖으로 나가면 안으로 민다(아래가 모자라면 항목 위로). 폭 340px.
- 닫기는 §6.4 와 같다. 맵을 끌거나 확대하면 [마침]과 같이 닫는다. 닫으면 `.pl-on` 을 떼고 초점을 그 항목으로 돌린다.
- 가지 카드의 머리·한 문장을 누르면 순서 보기로 바꾸고 그 가지로 스크롤해 이름 칸에 초점을 둔다(맵에서는 가지 이름을 고치지 않는다). 가운데 카드를 누르면 순서 보기의 중심 사상 칸으로 간다.

## 10. 끌어 놓기

넓은 화면에서 마우스로만 쓴다(터치·좁은 화면은 차림표). HTML 끌어 놓기 API 를 쓰고, `dataTransfer` 에는 `application/x-pl-item`(항목 id) 또는 `application/x-pl-clip`(자료 id)을 싣는다. 끄는 것에 `.pl-dragging`.

| 끄는 것 | 놓을 수 있는 곳 | 되는 일 |
|-|-|-|
| 항목(순서 보기 `.pl-item-row`) | 다른 항목의 위쪽 / 아래쪽 / 오른쪽 아래 | 그 앞 / 뒤 / 아래 단계로 옮김 |
| 〃 | 가지(`.pl-branch`)의 빈 곳·빈 가지 안내·[＋ 항목] | 그 가지의 끝으로 |
| 항목(맵 `.pl-map-item`) | 다른 가지 카드(`.pl-map-node`) | 그 가지의 끝으로(맵에서는 가지 안 차례를 바꾸지 않는다) |
| 자료(`.pl-clip`) | 순서 보기의 위 자리들, 맵의 가지 카드 | 그 자리에 **복사**해 넣음(자료함에 남고 `.pl-used`) |

놓을 자리 정하기(순서 보기, `dragover` 때마다).

- 포인터가 항목 줄(`.pl-item-row`)의 위 절반 → `.pl-drop-before`. 아래 절반 → `.pl-drop-after`.
- 아래 절반이면서 포인터 x 가 그 줄의 글 시작(`.pl-item-body` 의 왼쪽)보다 **32px 넘게 오른쪽** → `.pl-drop-child`. 단 그 항목이 이미 아래 단계이거나, 끄는 항목에 아래 단계가 있으면 `.pl-drop-after` 로 둔다(두 단계까지만).
- 항목 줄이 아닌 가지 안 → 그 가지에 `.pl-drop`.
- 표시 클래스는 한 번에 한 곳에만 둔다(옮길 때마다 앞의 것을 뗀다). `dragleave` 로 `.pl-root` 를 벗어나거나 `drop`·`dragend` 면 모두 뗀다.
- 놓을 수 없는 곳: 자기 자신, 자기의 아래 단계 안. 이때는 표시를 붙이지 않고 `dropEffect = "none"`.
- 아래 단계가 있는 항목은 함께 움직인다. 아래 단계였던 항목을 가지에 놓으면 윗단계가 된다.
- 한도(항목 400개)에 닿았으면 자료를 놓을 수 없다: 표시를 붙이지 않고, 놓으면 §12.6 의 알림.
- 끄는 동안 포인터가 스크롤 영역의 위·아래 40px 안이면 천천히 스크롤한다.

맵에서는 가지 카드에 `.pl-drop` 만 쓴다. 빈 카드의 안내 글귀를 그동안 `여기에 놓으면 {가지 이름}에 들어갑니다` 로 바꾼다.

## 11. 키보드

| 자리 | 키 | 하는 일 |
|-|-|-|
| 어디서나 | Tab / Shift+Tab | 화면 차례대로(머리 → 본문 → 자료함). 고치는 중이 아닐 때 |
| 항목 글(`.pl-item-text`) | Enter, F2 | 고치기 |
| 〃 | ↑ / ↓ | 앞 / 다음 항목 글로(가지를 넘어간다) |
| 〃 | Alt+↑ / Alt+↓ | 같은 단계 안에서 차례 바꾸기. 끝에서는 앞·뒤 가지로 넘어간다 |
| 〃 | Tab / Shift+Tab | 아래 단계로 / 밖으로. **옮길 수 있을 때만** 가로채고, 못 옮기면 초점이 그냥 넘어간다 |
| 〃 | Delete | 지우기(§6.2 와 같은 물음) |
| 고치는 중 | Ctrl+Enter / Esc | 마침 / 취소 |
| 가지 이름 칸 | Enter | 한 문장 칸으로 |
| 한 문장·중심 사상 칸 | Enter | 줄바꿈하지 않고 칸에서 나온다(한 문장이다) |
| 가지 이름 칸(대지) | Alt+↑ / Alt+↓ | 대지 차례 바꾸기 |
| 자료(`.pl-clip`, `tabindex="0"`) | Enter | [넣기] 차림표 열기 |
| 〃 | Delete | 자료함에서 지우기 |
| 자료함 찾기 칸 | Esc | 비우기 |
| 맵(`.pl-map-view`) | 화살표 | 40px 씩 움직이기 |
| 〃 | `+` / `-` / `0` | 크게 / 작게 / 한눈에 |
| 맵 항목 | Enter | 고침 칸 열기 |
| 차림표 | ↑ ↓ Home End Enter Esc | §2.1 |

옮기거나 지운 뒤에는 초점을 잃지 않게 한다(옮긴 항목, 지운 자리의 이웃). 차례가 바뀌면 `role="status"` 인 숨은 줄(`<span class="pl-sr" role="status">`)에 `2.3으로 옮겼습니다` 처럼 알린다. 초점 테두리는 CSS 가 그린다(지우지 않는다).

## 12. 글귀

### 12.1 단추·이름

| 자리 | 글귀 |
|-|-|
| 목록 | `설교 설계도` / `찾은 자료를 설교 차례대로 엮습니다.` / `새 설계도` / `설계도 {n}개` / `{때} 고침` |
| 머리 | `순서 보기` `마인드맵` `내보내기` `설교 정보` `일자` `예배` `장소` `설교자` |
| 가지 | `서론` `대지 {n}` `결론` `더 공부할 것` `중심 사상` |
| 순서 보기 | `항목` `대지 더하기` `더 공부할 것 두기` `더 공부할 것 빼기` `마침` `취소` `출처` `메모` |
| 자료함 | `자료함` `직접 쓰기` `붙여넣기` `넣기` `넣음` `넣음 · {가지}` `넣음 · {n}곳` |
| 마인드맵 | `둘레로` `좌우로` `한눈에` `{n}개 더 보기` `접기` `출처 열기` |
| 옮기기 | `위로` `아래로` `윗항목 아래 단계로` `한 단계 밖으로` `다른 가지로` `지우기` |
| 저장 | `저장됨` `저장 중…` `저장하지 못했습니다` `다시 하기` |

### 12.2 칸 안내(placeholder)

| 칸 | 글귀 |
|-|-|
| 제목 | `설교 제목` |
| 본문 | `본문  예: 요 15:1-8` |
| 중심 사상 | `이 설교가 말하려는 한 문장` |
| 가지 이름 | `이름을 붙여도 됩니다` |
| 한 문장 | `이 가지에서 말할 한 문장` |
| 메모 | `예: 예화로` |
| 장소 / 설교자 | `예: 본당` / `이름` |
| 자료함 찾기 | `자료함에서 찾기` |
| 새 항목 글 | `여기에 쓰세요` |

### 12.3 빈 가지

| 때 | 글귀 |
|-|-|
| 넓은 화면 | `아직 넣은 자료가 없습니다. 자료함에서 끌어다 놓거나 아래에서 직접 쓰세요.` |
| 좁은 화면 | `아직 넣은 자료가 없습니다. 자료함에서 [넣기]로 넣거나 아래에서 직접 쓰세요.` |
| 맵의 빈 카드 | `비어 있습니다` |
| 맵의 빈 카드에 놓는 중 | `여기에 놓으면 {가지 이름}에 들어갑니다` |

### 12.4 빈 상태

| 때 | 글귀 |
|-|-|
| 설계도가 없음 | `아직 설계도가 없습니다. 본문을 정하고 서론·대지·결론에 자료를 놓아 보세요.` + [새 설계도] |
| 자료함이 비었음 | `담아 둔 자료가 없습니다. 성경·주석·사전·연구 보고서에서 글을 고르고 "설계도에 담기"를 누르면 여기에 모입니다.` |
| 자료함에서 찾은 것이 없음 | `"{찾는 말}"이 들어간 자료가 없습니다.` |
| 제목·본문이 비었을 때 보이는 이름 | `제목 없는 설계도` / `본문 없음` |

### 12.5 자료 종류(`.pl-kind`)

`verse` 성경 · `comm` 주석 · `lex` 사전 · `article` 소논문 · `page` 책 · `ai` AI 연구 · `memo` 메모 · `web` 웹 · `own` 직접

### 12.6 물음(`host.confirm`)과 알림(`host.toast`)

물음은 되돌릴 수 없는 일에만 쓴다.

| 때 | 물음 |
|-|-|
| 설계도 지우기 | `"{제목}" 설계도를 지울까요? 되돌릴 수 없습니다.` |
| 항목이 든 대지 빼기 | `{가지 이름}에 항목이 {n}개 있습니다. 대지를 빼면 항목도 지워집니다. 뺄까요?` |
| 항목이 든 "더 공부할 것" 빼기 | `더 공부할 것에 항목이 {n}개 있습니다. 빼면 항목도 지워집니다. 뺄까요?` |
| 아래 단계가 있는 항목 지우기 | `아래 항목 {n}개도 함께 지워집니다. 지울까요?` |
| 저장하지 못한 채 목록으로 | `고친 내용을 아직 저장하지 못했습니다. 그래도 나갈까요?` |

| 때 | 알림 |
|-|-|
| 항목 지움 | `항목을 지웠습니다` |
| 자료함에서 지움 | `자료함에서 지웠습니다` |
| 가지에 넣음 | `{가지 이름}에 넣었습니다` |
| 자료함에 담음(바깥의 담기 단추) | `자료함에 담았습니다` |
| 글로 복사 | `설계도를 복사했습니다` |
| 파일로 저장 | `파일로 저장했습니다` |
| 설교 자료실에 넣음 | `내 설교 자료실에 초안으로 넣었습니다` |
| 설교 자료실에 넣지 못함 | `자료실에 넣지 못했습니다. {error}` |
| 복사하지 못함 | `복사하지 못했습니다` |
| 붙여넣을 글이 없음 | `붙여넣을 글이 없습니다` |
| 클립보드를 읽지 못함 | `클립보드를 읽지 못했습니다. 자료함의 [직접 쓰기]에 붙여 넣어 주세요.` |
| 글이 4,000자를 넘음 | `한 칸에는 4,000자까지 들어갑니다. 뒷부분을 잘랐습니다.` |
| 항목이 400개 | `설계도 하나에 항목은 400개까지 넣을 수 있습니다` |
| 설계도가 100개 | `설계도는 100개까지 둘 수 있습니다. 쓰지 않는 것을 지워 주세요.` |
| 자료함이 500칸 | `자료함이 가득 찼습니다(500칸). 쓰지 않는 자료를 지워 주세요.` |
| 대지가 7개 | `대지는 7개까지 둘 수 있습니다` |
| AI 연구로 보냄 | (알림 없음. 연구 화면이 열린다) |

글귀 원칙: 짧게, 평소 쓰는 말로. "~하시겠습니까", "성공적으로", "완료되었습니다" 같은 말을 쓰지 않는다. 알림 끝에는 마침표를 찍지 않고(한 문장일 때), 두 문장이면 찍는다.

## 13. 접근성 점검표

- 모든 아이콘 단추에 `aria-label` 과 `title`. 손잡이(`.pl-grip`)는 `aria-hidden` + `tabindex="-1"`(키보드는 Alt+화살표와 [옮기기]로 한다).
- 보기 고르기는 `role="tablist"`/`tab`, 배치 고르기는 `role="radiogroup"`/`radio`. 고른 것의 `aria-selected`·`aria-checked` 를 `.pl-on` 과 함께 바꾼다.
- 저장 상태는 `role="status"`. 확대 값은 `aria-live="polite"`.
- 누르는 자리: 넓은 화면 28px, 좁은 화면·터치 40px(`--pl-hit`). 출처 글자(`.pl-src`)는 글자는 작지만 `::after` 로 누르는 자리를 넓혀 두었다. 스크립트에서 높이를 따로 주지 않는다.
- 색만으로 뜻을 전하지 않는다: 가지는 색과 함께 이름·번호가 있고, "넣음"은 체크와 글자가, 저장 실패는 글귀가 있다.
- 움직임 줄이기 설정이면 CSS 전환이 꺼진다. 스크립트로 넣는 움직임(맵 맞추기, 스크롤)도 `matchMedia("(prefers-reduced-motion: reduce)")` 면 한 번에 옮긴다.
