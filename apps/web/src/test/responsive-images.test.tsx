import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { PrivateImage } from '../components/common';

const id = 'e59086a6-4e24-4c96-bcc4-b982448ba241';
const prefix = `/v1/assets/${id}/media/`;

describe('responsive private media', () => {
  it('advertises small and medium variants for grid tiles only', () => {
    render(<PrivateImage assetId={id} alt="Fotografia" sizes="125px"
      src={prefix + 'thumbnail_medium'} />);
    const image = screen.getByRole('img', { name: 'Fotografia' });
    expect(image.getAttribute('srcset')).toContain('thumbnail_small 240w');
    expect(image.getAttribute('srcset')).toContain('thumbnail_medium 640w');
    expect(image.getAttribute('srcset')).not.toContain('preview_large');
    expect(image).toHaveAttribute('sizes', '125px');
  });

  it('includes the large preview for the full-screen viewer', () => {
    render(<PrivateImage assetId={id} alt="Viewer"
      priority src={prefix + 'preview_large'} />);
    const image = screen.getByRole('img', { name: 'Viewer' });
    expect(image.getAttribute('srcset')).toContain('preview_large 1600w');
    expect(image).toHaveAttribute('loading', 'eager');
  });

  it('retains a fallback without an srcSet loop after an image error', () => {
    render(<PrivateImage assetId={id} alt="Foto"
      priority src={prefix + 'preview_large'} />);
    fireEvent.error(screen.getByRole('img', { name: 'Foto' }));
    const image = screen.getByRole('img', { name: 'Foto' });
    expect(image).toHaveAttribute('src', prefix + 'thumbnail_medium');
    expect(image.getAttribute('srcset')).toBeNull();
  });
});
