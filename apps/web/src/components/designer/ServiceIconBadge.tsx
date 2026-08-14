import { cn } from '@/lib/utils';
import { iconFor, isBrandedIcon } from './service-icons';

interface ServiceIconBadgeProps {
  iconName: string | undefined;
  color: string;
  /** Outer tile size classes, e.g. "h-10 w-10". */
  sizeClassName?: string;
  /** Glyph size classes for Lucide icons, e.g. "h-5 w-5". Branded icons fill the tile. */
  glyphClassName?: string;
  className?: string;
}

/**
 * Lucide glyphs are inverted onto a tile filled with the service colour.
 * Branded AWS marks carry their own colour, so they are drawn on nothing: a
 * tile behind them fights the mark instead of framing it.
 */
export function ServiceIconBadge({
  iconName,
  color,
  sizeClassName = 'h-10 w-10',
  glyphClassName = 'h-5 w-5',
  className,
}: ServiceIconBadgeProps) {
  const Icon = iconFor(iconName);
  const branded = isBrandedIcon(iconName);

  return (
    <div
      className={cn(
        'flex shrink-0 items-center justify-center rounded-lg',
        // The AWS architecture marks are square tiles that fill the badge edge
        // to edge, so without clipping their corners sit outside the rounding.
        branded && 'overflow-hidden',
        sizeClassName,
        className
      )}
      style={branded ? undefined : { backgroundColor: color }}
    >
      <Icon className={branded ? 'h-full w-full' : cn(glyphClassName, 'text-white')} />
    </div>
  );
}
