import type { SVGProps } from 'react';

/**
 * The AWS Lambda resource icon: an outlined lambda inside a ring.
 *
 * Traced from the official mark, so the letterform is the real one rather than
 * an approximation -- the lambda is two outlined strokes with hollow centres,
 * which is why this is a filled path with `evenodd` rather than a stroked one.
 * Colour is baked in at the brand orange, so this icon is drawn on the tile
 * background instead of being inverted onto a coloured one.
 */
export function AwsLambdaIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 80" fill="none" aria-hidden {...props}>
      <circle cx="40" cy="40" r="38.22" stroke="#ED7100" strokeWidth="3.55" />
      <path
        fill="#ED7100"
        fillRule="evenodd"
        d="M23.85 9.47 L40.59 9.47 L41.78 10.32 L59.7 49.22 L64.61 49.39 L65.62 50.4 L65.79 62.41 L64.95 63.93 L50.4 64.1 L49.56 63.59 L31.46 24.52 L23.68 24.36 L22.33 23.17 L22.33 10.99 L22.66 10.15ZM26.05 13.19 L25.88 20.63 L33.15 20.8 L34.16 21.65 L51.92 60.21 L52.26 60.55 L62.07 60.55 L62.07 53.11 L58.69 53.11 L57 52.09 L39.24 13.36ZM28.92 30.27 L30.11 30.27 L31.12 31.12 L38.05 45.5 L38.22 46.68 L37.89 47.7 L29.94 63.93 L14.38 64.1 L13.36 63.09 L13.36 61.56 L26.55 33.83 L27.91 31.12ZM29.6 36.53 L18.1 60.55 L27.74 60.55 L28.08 60.04 L34.33 46.68 L34.33 46Z"
      />
    </svg>
  );
}
