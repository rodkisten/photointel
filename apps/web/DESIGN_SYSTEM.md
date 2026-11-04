# PhotoIntel Design System

> **Nota de revisão arquitetural (04/11/2026):** O design system do PhotoIntel usa Tailwind 4 e tokens locais; componentes de páginas, jobs drawer e estados de erro devem manter consistência. O Manage possui frontend e estilos próprios. Confira [a referência de código e fluxos](../../docs/architecture/FRONTENDS_AND_BRIDGE.md).

Dark-neutral design tokens live in `apps/web/src/design-system.css`. All existing
application class names remain in `styles.css`.

## Main controls

- `--ui-gray-tone: 3.5%` is the base canvas luminance (achromatic HSL).
- `--ui-contrast: 1.22` expands the luminance gap between surfaces, borders,
  and text. Try `1` for softer contrast or `1.4` for stronger contrast.
- `--font-size-base: 1rem` (normally 16px) controls all typography tokens.
  The 20 original steps use `calc(var(--font-size-base) * N / 16)`.
  `1rem` preserves the existing sizes; `18px` makes each size 12.5% larger.
- `--ui-density: comfortable` (or `compact`) controls supported container
  layouts and field spacing.

Both controls are native CSS custom properties, with `@property` registrations.
A runtime theme panel can use:

```ts
document.documentElement.style.setProperty('--ui-gray-tone', '4%');
document.documentElement.style.setProperty('--ui-contrast', '1.3');
document.documentElement.style.setProperty('--font-size-base', '18px');
```

The entire neutral ramp `--gray-0` through `--gray-17` is computed using
`hsl()` and `calc()`. Hue and saturation are always zero. Component
styles should prefer semantic tokens such as `--surface-panel`,
`--border-default`, `--text-muted`, `--state-danger-bg` instead of
adding new hex literals. Status colors are exceptions intentionally.

## Size and layout

Use `--space-1` to `--space-14` for spacing; `--radius-sm`,
`--radius-md`, `--radius-lg`; `--text-10` to `--text-33` for
typographic sizes, now calculated from the single `--font-size-base` token.
Tailwind's `text-xs`, `text-sm`, `text-base` through `text-4xl` utilities also
share the base and proportionally scaled line heights.
Shared classes use Tailwind 4's `@apply` when helpful.

The page, panel, filters and other responsive regions use named
`container-type: inline-size` containers and `@container` rules. This
adapts content to available width, not just viewport width. `cqi`
units are used selectively. There is also a `@container style(...)`
query for `--ui-density: compact`. Size/container query units are
supported by Safari 16+ and custom-property style queries by Safari 18+.

## iPhone Safari

Native inputs/selects/textareas stay at 16px or above on small screens to prevent
focus zoom. The old `transform: scale(.92)` workaround was removed to
avoid undersized hit targets, overflow, and blurry text. Safe-area
insets, dynamic viewport units, reduced motion and touch behavior remain.

## Tailwind

`@theme inline` exposes `bg-background`, `text-foreground`,
`bg-panel`, `border-border` etc. Component classes remain source
compatible. Do not introduce duplicate late `:root` theme overrides.
