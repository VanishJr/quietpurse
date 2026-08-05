/**
 * The icons the login and register designs use, exported from Figma
 * (design file) and inlined rather than fetched: the MCP asset URLs
 * expire in about a week, and a login screen must not depend on a network round
 * trip to draw its own controls.
 *
 * Each one keeps the geometry the design gave it — a leaf of its own size,
 * centred in a larger box (eye 26.17x18.92 and eye-off 26.17x26.17 in 29x29,
 * alert 23.68x21.52 in 26x26, arrow 16x16 in 24x24, the two circles 22x22 in
 * 24x24). The box is what the layout positions; scaling the leaf to fill it
 * would thicken the strokes against the rest of the set.
 *
 * `stroke` is currentColor so the caller's color decides — the exports hardcode
 * white, black, #A70000 and #009405, which are the colors the callers set anyway.
 */

import { ReactNode } from 'react';

/** The box a leaf sits centred in. Sizes come from the design, not from the SVG. */
function IconBox({ size, children }: { size: number; children: ReactNode }) {
  return (
    <span
      aria-hidden="true"
      style={{
        width: size,
        height: size,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        flex: 'none',
      }}
    >
      {children}
    </span>
  );
}

export function EyeIcon() {
  return (
    <IconBox size={29}>
      <svg width="26.1679" height="18.9152" viewBox="0 0 26.1679 18.9152" fill="none">
        <path
          d="M1.07553 9.87809C0.974824 9.6068 0.974824 9.30838 1.07553 9.03709C2.05633 6.65891 3.72119 4.62551 5.85904 3.19467C7.99689 1.76384 10.5115 1 13.0839 1C15.6564 1 18.171 1.76384 20.3088 3.19467C22.4467 4.62551 24.1116 6.65891 25.0924 9.03709C25.1931 9.30838 25.1931 9.6068 25.0924 9.87809C24.1116 12.2563 22.4467 14.2897 20.3088 15.7205C18.171 17.1513 15.6564 17.9152 13.0839 17.9152C10.5115 17.9152 7.99689 17.1513 5.85904 15.7205C3.72119 14.2897 2.05633 12.2563 1.07553 9.87809Z"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d="M13.0839 13.0824C15.086 13.0824 16.7089 11.4595 16.7089 9.45745C16.7089 7.45542 15.086 5.83245 13.0839 5.83245C11.0819 5.83245 9.45892 7.45542 9.45892 9.45745C9.45892 11.4595 11.0819 13.0824 13.0839 13.0824Z"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </IconBox>
  );
}

/**
 * The second glyph for the same control, from the register frame (2009:278),
 * where it sits beside a password drawn in plain text. So: eye means "it is
 * hidden, show it", eye-off means "it is showing, hide it" — the design does
 * give this control two states after all, and the screen no longer has to say
 * so by dimming one of them.
 */
export function EyeOffIcon() {
  return (
    <IconBox size={29}>
      <svg width="26.1678" height="26.1667" viewBox="0 0 26.1678 26.1667" fill="none">
        <path
          d="M11.5529 4.71682C14.3675 4.38139 17.2146 4.97639 19.6594 6.41096C22.1042 7.84553 24.0122 10.0408 25.0922 12.6616C25.1929 12.9329 25.1929 13.2313 25.0922 13.5026C24.6482 14.5792 24.0613 15.5912 23.3474 16.5114M15.602 15.6909C14.9183 16.3513 14.0026 16.7166 13.0521 16.7084C12.1017 16.7001 11.1925 16.3189 10.5204 15.6468C9.84826 14.9747 9.46703 14.0655 9.45877 13.115C9.45051 12.1645 9.81589 11.2489 10.4762 10.5652M19.7044 19.728C18.1015 20.6775 16.3132 21.2711 14.4607 21.4685C12.6082 21.6659 10.7349 21.4625 8.96791 20.8721C7.20094 20.2818 5.58164 19.3182 4.21987 18.0469C2.8581 16.7756 1.78573 15.2262 1.07553 13.5039C0.974824 13.2326 0.974824 12.9342 1.07553 12.6629C2.14687 10.0648 4.03192 7.88421 6.44778 6.44841M1.00059 1L25.1673 25.1667"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </IconBox>
  );
}

/**
 * A password rule the typed password satisfies (register frame, 2009:440).
 *
 * The only icon here that takes a size, because it is the only one used at two:
 * 24 in the rules list, where the frame puts it, and once as the mark on the
 * screen after a reset — which is not in the Figma file, so nothing there was
 * drawn to size either (debt §1). Box and leaf scale together, so the 22-in-24
 * the frame gave it survives; the stroke thickens with them, which is what a
 * stroked glyph does when it is used large.
 */
export function CircleCheckIcon({ size = 24 }: { size?: number }) {
  const leaf = (22 / 24) * size;
  return (
    <IconBox size={size}>
      <svg width={leaf} height={leaf} viewBox="0 0 22 22" fill="none">
        <path
          d="M20.7987 9.00341C21.2554 11.2447 20.9299 13.5748 19.8765 15.6052C18.8231 17.6356 17.1056 19.2435 15.0102 20.1607C12.9148 21.078 10.5683 21.2492 8.36196 20.6458C6.15563 20.0424 4.22285 18.7008 2.88594 16.8448C1.54902 14.9889 0.888781 12.7306 1.01532 10.4468C1.14186 8.16294 2.04754 5.9915 3.58131 4.29458C5.11508 2.59766 7.18424 1.47784 9.44372 1.12186C11.7032 0.765885 14.0164 1.19527 15.9977 2.33841M7.99756 10.0034L10.9976 13.0034L20.9976 3.00342"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </IconBox>
  );
}

/** One it does not (register frame, 2009:508). */
export function CircleXIcon() {
  return (
    <IconBox size={24}>
      <svg width="22" height="22" viewBox="0 0 22 22" fill="none">
        <path
          d="M14 8L8 14M8 8L14 14M21 11C21 16.5228 16.5228 21 11 21C5.47715 21 1 16.5228 1 11C1 5.47715 5.47715 1 11 1C16.5228 1 21 5.47715 21 11Z"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </IconBox>
  );
}

export function TriangleAlertIcon() {
  return (
    <IconBox size={26}>
      <svg width="23.6839" height="21.5151" viewBox="0 0 23.6839 21.5151" fill="none">
        <path
          d="M11.8528 7.51508V11.8484M11.8528 16.1817H11.8636M22.3937 17.2651L13.727 2.09839C13.538 1.76494 13.264 1.48759 12.9328 1.29463C12.6017 1.10167 12.2253 1 11.842 1C11.4587 1 11.0823 1.10167 10.7512 1.29463C10.42 1.48759 10.146 1.76494 9.957 2.09839L1.29033 17.2651C1.09932 17.5959 0.999159 17.9713 1.00001 18.3533C1.00085 18.7353 1.10267 19.1102 1.29515 19.4402C1.48762 19.7702 1.76391 20.0434 2.096 20.2321C2.42809 20.4209 2.80419 20.5185 3.18616 20.5151H20.5195C20.8996 20.5147 21.273 20.4143 21.6021 20.2239C21.9311 20.0336 22.2043 19.7601 22.3942 19.4308C22.5841 19.1015 22.684 18.728 22.6839 18.3478C22.6838 17.9677 22.5837 17.5943 22.3937 17.2651Z"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </IconBox>
  );
}

export function ArrowLeftIcon() {
  return (
    <IconBox size={24}>
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
        <path
          d="M8 1L1 8L8 15M1 8H15"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </IconBox>
  );
}
