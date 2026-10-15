/** Curated, rights-cleared Côte d'Ivoire location references bundled with the Studio. */
export const locationCatalog = [
  { id: 'd55c82b1-95d3-4d2e-a2d2-25068739d201', title: 'Pont HKB · journée', category: 'Abidjan · pont et lagune', path: '/places/abidjan-pont-hkb-jour.png', location: 'Abidjan, pont Henri-Konan-Bédié', setting: 'Pont à haubans blanc, lagune Ébrié et skyline d’Abidjan en plein jour' },
  { id: 'd55c82b1-95d3-4d2e-a2d2-25068739d202', title: 'Route rouge · végétation tropicale', category: 'Côte d’Ivoire · route en terre', path: '/places/cote-ivoire-route-rouge-foret.jpg', location: 'Côte d’Ivoire, route latéritique en zone végétalisée', setting: 'Piste rouge bordée d’une végétation tropicale dense' },
  { id: 'd55c82b1-95d3-4d2e-a2d2-25068739d203', title: 'Plateau et lagune · nuit', category: 'Abidjan · vue aérienne nocturne', path: '/places/abidjan-lagune-plateau-nuit.jpg', location: 'Abidjan, Plateau et lagune Ébrié', setting: 'Vue aérienne nocturne du front lagunaire et des lumières du Plateau' },
  { id: 'd55c82b1-95d3-4d2e-a2d2-25068739d204', title: 'Boulevard lagunaire · nuit', category: 'Abidjan · boulevard nocturne', path: '/places/abidjan-boulevard-lagunaire-nuit.jpeg', location: 'Abidjan, boulevard du front lagunaire', setting: 'Boulevard éclairé longeant la lagune avec immeubles en arrière-plan, de nuit' },
  { id: 'd55c82b1-95d3-4d2e-a2d2-25068739d205', title: 'Plateau et bord de mer · journée', category: 'Abidjan · architecture et littoral', path: '/places/abidjan-plateau-front-de-mer-jour.jpeg', location: 'Abidjan, Plateau et front de mer', setting: 'Tours du Plateau, boulevard côtier et lagune sous une lumière de jour' },
  { id: 'd55c82b1-95d3-4d2e-a2d2-25068739d206', title: 'Front lagunaire · nuit, vue aérienne', category: 'Abidjan · vue aérienne nocturne', path: '/places/abidjan-boulevard-lagunaire-vue-aerienne-nuit.jpeg', location: 'Abidjan, boulevard et front lagunaire', setting: 'Vue aérienne nocturne d’un boulevard éclairé au bord de la lagune' },
] as const;

export type CuratedLocation = (typeof locationCatalog)[number];

export function findCuratedLocation(id: string): CuratedLocation | undefined {
  return locationCatalog.find((location) => location.id === id);
}

export function curatedLocationAsset(location: CuratedLocation) {
  return { id: location.id, kind: 'place' as const, title: location.title, category: location.category, path: location.path, status: 'validée' as const, previewUrl: location.path, isCurated: true as const };
}
