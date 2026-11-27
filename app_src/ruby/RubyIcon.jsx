// Ruby (行间注) button icon: a serif T with two small t stacked beside it, as
// notes sit beside a vertical column. Same props as a react-icons icon.
import React from "react";

// A small t, its top-left corner at (x, y), 5 wide and 7 high
const smallT = (x, y) =>
  `M${x + 1.4} ${y}h1.8v1.6h1.8v1.4h-1.8v3q0 .6.6.6h1.2v1.4h-1.6q-2 0-2-2v-3h-1.4v-1.4h1.4z`;

export default function RubyIcon({ size = 14, className, ...rest }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
      className={className}
      {...rest}
    >
      <path d="M1 3.5h14v5h-1.8v-3H9.6v13h2v2H4.4v-2h2v-13H2.8v3H1z" />
      <path d={smallT(17, 3.5) + smallT(17, 13.5)} />
    </svg>
  );
}
