import {NativeSelect, NumberInput, Pagination} from '@mantine/core';
import {useEffect, useState} from 'react';

export function pageWindow(count, settings, defaultSize) {
  const size = settings?.size ?? defaultSize;
  const total = Math.max(1, Math.ceil(count / size));
  const page = Math.max(1, Math.min(total, settings?.page ?? 1));
  const start = (page - 1) * size;
  return {size, total, page, start, end: Math.min(count, start + size)};
}

export function PageControls({label, noun, count, window, sizes, onChange}) {
  const {page, size, total, start, end} = window;
  const [draft, setDraft] = useState(page);
  useEffect(() => setDraft(page), [page]);
  const jump = () => {
    const next = Math.max(1, Math.min(total, Math.trunc(Number(draft)) || 1));
    setDraft(next);
    if (next !== page) onChange({page: next, size});
  };
  return (
    <nav className="page-controls" aria-label={label + ' pagination'}>
      <span className="page-range" aria-live="polite">
        {count ? start + 1 : 0}–{end} of {count.toLocaleString()} {noun}
      </span>
      <div className="page-navigation">
        <Pagination
          total={total}
          value={page}
          onChange={(next) => onChange({page: next, size})}
          size="xs"
          siblings={0}
          boundaries={1}
          getItemProps={(value) => ({'aria-label': label + ' page ' + value})}
          getControlProps={(control) => ({
            'aria-label': label + ' ' + control + ' page',
          })}
        />
        <label className="page-jump">
          Page
          <NumberInput
            aria-label={label + ' page'}
            value={draft}
            onChange={setDraft}
            onBlur={jump}
            onKeyDown={(event) => {
              if (event.key === 'Enter') jump();
            }}
            min={1}
            max={total}
            clampBehavior="none"
            allowDecimal={false}
            allowNegative={false}
            hideControls
            size="xs"
          />
        </label>
        <label className="page-size">
          Per page
          <NativeSelect
            aria-label={label + ' per page'}
            size="xs"
            value={size}
            onChange={(event) => {
              const next = Number(event.currentTarget.value);
              onChange({page: Math.floor(start / next) + 1, size: next});
            }}
            data={sizes.map(String)}
          />
        </label>
      </div>
    </nav>
  );
}
