export const vehicleCategories = ['berline', 'suv', 'pickup', 'camion', 'bus', 'engin', 'autre'] as const;
export type VehicleCategory = typeof vehicleCategories[number];

export const vehicleCategoryLabels: Record<VehicleCategory, string> = {
  berline: 'Berline / voiture électrique',
  suv: 'SUV / 4x4',
  pickup: 'Pick-up',
  camion: 'Camion / poids lourd',
  bus: 'Bus / transport collectif',
  engin: 'Engin de chantier',
  autre: 'Autre véhicule',
};

export type ScenePreset = {
  id: string;
  category: VehicleCategory;
  label: string;
  location: string;
  setting: string;
  character?: string;
  lighting: string;
  vehicleAction: string;
  cameraMovement: string;
  mood: string;
};

export const scenePresets: ScenePreset[] = [
  { id: 'sedan-business-day', category: 'berline', label: 'Quartier d’affaires · jour', location: 'Abidjan, quartier d’affaires du Plateau', setting: 'Architecture contemporaine, boulevard dégagé et circulation discrète', lighting: 'Lumière naturelle claire du matin', vehicleAction: 'Le véhicule avance lentement et régulièrement sur une courte distance', cameraMovement: 'Travelling latéral fluide en trois-quarts avant, à hauteur du véhicule', mood: 'Élégant, moderne et rassurant' },
  { id: 'sedan-business-night', category: 'berline', label: 'Quartier d’affaires · nuit', location: 'Abidjan, quartier d’affaires du Plateau', setting: 'Façades de bureaux éclairées, boulevard calme et reflets naturels', lighting: 'Nuit urbaine avec éclairage doux et réaliste', vehicleAction: 'Le véhicule roule lentement sur une courte distance', cameraMovement: 'Travelling latéral stable en trois-quarts avant', mood: 'Premium, sobre et contemporain' },
  { id: 'sedan-coast-evening', category: 'berline', label: 'Route côtière · fin de journée', location: 'Abidjan, boulevard côtier', setting: 'Route ouverte, horizon dégagé et végétation côtière discrète', lighting: 'Lumière douce de fin de journée', vehicleAction: 'Le véhicule suit la route à vitesse régulière', cameraMovement: 'Travelling avant parallèle au véhicule, sans coupe', mood: 'Libre, élégant et apaisant' },
  { id: 'suv-city-day', category: 'suv', label: 'Avenue urbaine · jour', location: 'Abidjan, avenue moderne bordée d’arbres', setting: 'Voie dégagée et architecture urbaine contemporaine', lighting: 'Lumière naturelle claire du matin', vehicleAction: 'Le véhicule avance lentement dans sa voie', cameraMovement: 'Travelling trois-quarts avant, stable et à hauteur du véhicule', mood: 'Confiant, polyvalent et premium' },
  { id: 'suv-coast-evening', category: 'suv', label: 'Route côtière · fin de journée', location: 'Route côtière près d’Abidjan', setting: 'Route ouverte avec végétation tropicale en arrière-plan', lighting: 'Lumière douce de fin de journée', vehicleAction: 'Le véhicule progresse sans accélération brusque', cameraMovement: 'Travelling latéral fluide qui garde le véhicule au centre', mood: 'Évasion, confort et maîtrise' },
  { id: 'pickup-worksite-day', category: 'pickup', label: 'Site professionnel · jour', location: 'Zone d’activité en périphérie d’Abidjan', setting: 'Site de travail ordonné, matériaux rangés et circulation dégagée', lighting: 'Lumière naturelle claire du matin', vehicleAction: 'Le véhicule avance lentement sur une voie stabilisée', cameraMovement: 'Plan bas en travelling trois-quarts avant', mood: 'Robuste, fiable et professionnel' },
  { id: 'truck-logistics-day', category: 'camion', label: 'Plateforme logistique · jour', location: 'Plateforme logistique près d’Abidjan', setting: 'Entrepôts propres, espace de manœuvre large et activité en arrière-plan discrète', lighting: 'Lumière naturelle claire du matin', vehicleAction: 'Le véhicule traverse lentement la plateforme en ligne droite', cameraMovement: 'Plan large puis travelling parallèle régulier', mood: 'Puissant, fiable et maîtrisé' },
  { id: 'bus-terminal-day', category: 'bus', label: 'Terminal moderne · jour', location: 'Abidjan, terminal de transport moderne', setting: 'Quai propre, architecture fonctionnelle et voyageurs discrets au loin', lighting: 'Lumière naturelle claire du matin', vehicleAction: 'Le véhicule avance lentement le long du quai', cameraMovement: 'Travelling latéral large et régulier', mood: 'Sûr, accueillant et fiable' },
  { id: 'equipment-worksite-day', category: 'engin', label: 'Chantier organisé · jour', location: 'Chantier d’infrastructure près d’Abidjan', setting: 'Terrain de chantier sécurisé, sol stable et équipements en arrière-plan', lighting: 'Lumière naturelle claire du matin', vehicleAction: 'Le véhicule effectue un mouvement lent et maîtrisé sur place', cameraMovement: 'Plan bas trois-quarts, caméra stable avec un léger travelling', mood: 'Précis, puissant et professionnel' },
  { id: 'other-urban-day', category: 'autre', label: 'Scène urbaine · jour', location: 'Abidjan, rue calme et contemporaine', setting: 'Architecture sobre, voie dégagée et arrière-plan peu chargé', lighting: 'Lumière naturelle claire du matin', vehicleAction: 'Le véhicule avance lentement et régulièrement', cameraMovement: 'Travelling trois-quarts avant, stable et sans coupe', mood: 'Moderne, naturel et rassurant' },
];

export function inferVehicleCategory(make?: string | null, model?: string | null): VehicleCategory {
  const normalizedMake = (make ?? '').toLocaleLowerCase('fr');
  const normalizedModel = (model ?? '').toLocaleLowerCase('fr');
  const identity = `${normalizedMake} ${normalizedModel}`;
  if (/liugong|chargeuse|excavatrice|bulldozer|niveleuse|compacteur/.test(identity)) return 'engin';
  if (/zhongtong|autocar|bus/.test(identity)) return 'bus';
  if (/sinotruk|howo|poids lourd|tracteur routier|camion/.test(identity)) return 'camion';
  if (/pick.?up|poer|wingle|cannon/.test(identity)) return 'pickup';
  if (/haval|gwm|tank\s?\d|jolion|h6|h9|suv|sportage|sorento|seltos|stonic|tucson|ev[3569]/.test(identity)) return 'suv';
  if (/starlight|sedan|berline|k[3458]|cerato|forte|stinger/.test(identity)) return 'berline';
  return 'autre';
}

export function getScenePresets(category?: VehicleCategory): ScenePreset[] {
  return category ? scenePresets.filter((preset) => preset.category === category) : scenePresets;
}

export function getScenePreset(id: string, category?: VehicleCategory): ScenePreset | undefined {
  return scenePresets.find((preset) => preset.id === id && (!category || preset.category === category));
}
