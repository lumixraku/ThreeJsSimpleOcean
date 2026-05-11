/**
 * Paths under `public/` (served at site root in dev and copied to dist in build).
 * Adjust filenames to match your exported textures.
 */
export const AssetPaths = {
  ocean: {
    baseColor: "/assets/textures/ocean/ocean.png",
    normal: "/assets/textures/ocean/ocean_normal.png",
    height: "/assets/textures/ocean/ocean_heightmap.png",
    foamMask: "/assets/textures/ocean/foam-mask.png",
  },
  grass: {
    model: "/assets/siegebound/models/terrain/grass/tile-grass.fbx",
    baseColor: "/assets/siegebound/models/terrain/grass/tile-grass_basecolor.png",
    normal: "/assets/siegebound/models/terrain/grass/tile-grass_normal.png",
  },
} as const;
