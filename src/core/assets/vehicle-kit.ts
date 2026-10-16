/** RIMCO vehicle images supplied in the internal test-assets archive. */
export const vehicleTestKit = [
  {
    make: 'GWM', model: 'Jolion', color: 'Bleu', variant: 'Kit d’essai visuel', slug: 'gwm-jolion',
    photos: [
      { file: 'arriere-trois-quarts.webp', title: 'Jolion bleu · arrière trois-quarts', angle: 'Arrière trois-quarts' },
      { file: 'avant-trois-quarts.webp', title: 'Jolion bleu · avant trois-quarts', angle: 'Avant trois-quarts' },
      { file: 'profil.webp', title: 'Jolion bleu · profil', angle: 'Profil' },
    ],
  },
  {
    make: 'Kia', model: 'Tasman', color: 'Beige', variant: 'Kit d’essai visuel', slug: 'kia-tasman',
    photos: [
      { file: 'avant-trois-quarts.webp', title: 'Tasman beige · avant trois-quarts', angle: 'Avant trois-quarts' },
      { file: 'arriere-trois-quarts.webp', title: 'Tasman beige · arrière trois-quarts', angle: 'Arrière trois-quarts' },
      { file: 'profil.webp', title: 'Tasman beige · profil', angle: 'Profil' },
    ],
  },
  {
    make: 'Kia', model: 'Pegas', color: 'Rouge', variant: 'Kit d’essai visuel', slug: 'kia-pegas',
    photos: [
      { file: 'arriere-trois-quarts.webp', title: 'Pegas rouge · arrière trois-quarts', angle: 'Arrière trois-quarts' },
      { file: 'profil.webp', title: 'Pegas rouge · profil', angle: 'Profil' },
      { file: 'avant-trois-quarts.webp', title: 'Pegas rouge · avant trois-quarts', angle: 'Avant trois-quarts' },
    ],
  },
  {
    make: 'Haval', model: 'H6', color: 'Beige', variant: 'Kit d’essai visuel', slug: 'haval-h6',
    photos: [
      { file: 'avant-trois-quarts.webp', title: 'Haval H6 beige · avant trois-quarts', angle: 'Avant trois-quarts' },
      { file: 'profil-avant.webp', title: 'Haval H6 beige · profil avant', angle: 'Profil avant' },
      { file: 'avant-trois-quarts-ville.webp', title: 'Haval H6 beige · avant trois-quarts en ville', angle: 'Avant trois-quarts' },
    ],
  },
  {
    make: 'GWM', model: 'Tank 300', color: 'Gris', variant: 'Kit d’essai visuel', slug: 'gwm-tank-300',
    photos: [
      { file: 'avant-trois-quarts.webp', title: 'Tank 300 gris · avant trois-quarts', angle: 'Avant trois-quarts' },
      { file: 'arriere-trois-quarts.webp', title: 'Tank 300 gris · arrière trois-quarts', angle: 'Arrière trois-quarts' },
      { file: 'profil.webp', title: 'Tank 300 gris · profil', angle: 'Profil' },
    ],
  },
] as const;

export type VehicleTestKitEntry = (typeof vehicleTestKit)[number];
