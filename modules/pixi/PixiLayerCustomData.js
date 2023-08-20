import * as PIXI from 'pixi.js';
import { geoBounds as d3_geoBounds } from 'd3-geo';
import { gpx, kml } from '@tmcw/togeojson';
import { Extent, geomPolygonIntersectsPolygon } from '@rapid-sdk/math';
import { utilArrayFlatten, utilArrayUnion, utilHashcode } from '@rapid-sdk/util';
import geojsonRewind from '@mapbox/geojson-rewind';
import stringify from 'fast-json-stable-stringify';

import { AbstractLayer } from './AbstractLayer';
import { PixiFeatureLine } from './PixiFeatureLine';
import { PixiFeaturePoint } from './PixiFeaturePoint';
import { PixiFeaturePolygon } from './PixiFeaturePolygon';
import { utilFetchResponse } from '../util';

const CUSTOM_COLOR = 0x00ffff;


/**
 * PixiLayerCustomData
 * This class contains any custom data traces that should be 'drawn over' the map.
 * This data only comes from the 'load custom data' option in the map data sidebar.
 * @class
 */
export class PixiLayerCustomData extends AbstractLayer {

  /**
   * @constructor
   * @param  scene    The Scene that owns this Layer
   * @param  layerID  Unique string to use for the name of this Layer
   */
  constructor(scene, layerID) {
    super(scene, layerID);
    this.enabled = true;     // this layer should always be enabled

    this._loadedUrlData = false;
    // setup the child containers
    // these only go visible if they have something to show

    this._geojson = {};
    this._template = null;
    this._fileList = null;
    this._src = null;

    this.setFile = this.setFile.bind(this);

    // Setup event handlers..
    // drag and drop
    function over(d3_event) {
      d3_event.stopPropagation();
      d3_event.preventDefault();
      d3_event.dataTransfer.dropEffect = 'copy';
    }
    this.context.container()
      .attr('dropzone', 'copy')
      .on('dragenter.draganddrop', over)
      .on('dragexit.draganddrop', over)
      .on('dragover.draganddrop', over)
      .on('drop.draganddrop', d3_event => {
        d3_event.stopPropagation();
        d3_event.preventDefault();
        this.fileList(d3_event.dataTransfer.files);
      });

    // Ensure methods used as callbacks always have `this` bound correctly.
    this._hashchange = this._hashchange.bind(this);

    // hashchange - pick out the 'gpx' param
    this.context.systems.urlhash
      .on('hashchange', this._hashchange);
  }


  // Prefer an array of Features instead of a FeatureCollection
  getFeatures(geojson) {
    if (!geojson) return [];

    if (geojson.type === 'FeatureCollection') {
      return geojson.features;
    } else {
      return [geojson];
    }
  }


  getExtension(fileName) {
    if (!fileName) return;

    const re = /\.(gpx|kml|(geo)?json)$/i;
    const match = fileName.toLowerCase().match(re);
    return match && match.length && match[0];
  }


  xmlToDom(textdata) {
    return (new DOMParser()).parseFromString(textdata, 'text/xml');
  }

  setFile(extension, data) {
    this._template = null;
    this._fileList = null;
    this._geojson = null;
    this._src = null;
    let gj;

    switch (extension) {
      case '.gpx':
        gj = gpx(this.xmlToDom(data));
        break;
      case '.kml':
        gj = kml(this.xmlToDom(data));
        break;
      case '.geojson':
      case '.json':
        gj = JSON.parse(data);
        break;
    }

    gj = gj || {};
    if (Object.keys(gj).length) {
      this._geojson = this._ensureIDs(gj);
      geojsonRewind(this._geojson);
      this._src = extension + ' data file';
      this.fitZoom();
    }

    return this;
  }


  /**
   * hasData
   * @return true if either there is a custom datafile loaded, or a vector tile template set.
   */
  hasData() {
    const gj = this._geojson || {};
    return !!(this._template || Object.keys(gj).length);
  }


  /**
   * render
   * Render the geojson custom data
   * @param  frame        Integer frame being rendered
   * @param  projection   Pixi projection to use for rendering
   * @param  zoom         Effective zoom to use for rendering
   */
  render(frame, projection, zoom) {
    if (this.enabled) {
      this.renderCustomData(frame, projection, zoom);
    }
  }


  /**
   * renderCustomData
   * Render the geojson custom data
   * @param  frame        Integer frame being rendered
   * @param  projection   Pixi projection to use for rendering
   * @param  zoom         Effective zoom to use for rendering
   */
  renderCustomData(frame, projection, zoom) {
    const vtService = this.context.services.vectortile;
    let geoData, polygons, lines, points;

    if (this._template && vtService) {   // fetch data from vector tile service
      vtService.loadTiles(this._template);
      geoData = vtService.getData(this._template).map(d => d.geojson);
    } else {
      geoData = this.getFeatures(this._geojson);
    }

    if (this.hasData()) {
      polygons = geoData.filter(d => d.geometry.type === 'Polygon' || d.geometry.type === 'MultiPolygon');
      lines = geoData.filter(d => d.geometry.type === 'LineString' || d.geometry.type === 'MultiLineString');
      points = geoData.filter(d => d.geometry.type === 'Point' || d.geometry.type === 'MultiPoint');

      this.renderPolygons(frame, projection, zoom, polygons);
      const gridLines = this.createGridLines(lines);
      const gridStyle = { stroke: { width: 0.5, color: 0x00ffff, alpha: 0.5, cap: PIXI.LINE_CAP.ROUND }};

      this.renderLines(frame, projection, zoom, lines);
      this.renderLines(frame, projection, zoom, gridLines, gridStyle);
      this.renderPoints(frame, projection, zoom, points);
    }
  }


  /**
   * createGridLines
   * creates interstitial grid lines inside the rectangular bounding box, if specified.
   * @param lines - the line string(s) that may contain a rectangular bounding box
   * @returns a list of linestrings to draw as gridlines.
  */
  createGridLines (lines) {
    const numSplits = this.context.systems.imagery.numGridSplits;
    let gridLines = [];

    //'isTaskRectangular' implies one and only one rectangular linestring.
    if (this.context.systems.rapid.isTaskRectangular && numSplits > 0) {
      const box = lines[0];

      const lats = box.geometry.coordinates.map((f) => f[0]);
      const lons = box.geometry.coordinates.map((f) => f[1]);

      const minLat = Math.min(...lats);
      const minLon = Math.min(...lons);
      const maxLat = Math.max(...lats);
      const maxLon = Math.max(...lons);

      let latIncrement = (maxLat - minLat) / numSplits;
      let lonIncrement = (maxLon - minLon) / numSplits;

      // num splits is a grid specificer, so 2 => 2x2 grid, 3 => 3x3 grid, all the way up to 6 => 6x6 grid.
      for (let i = 1; i < numSplits; i++) {
        let thisLat = minLat + latIncrement * i;
        let thisLon = minLon + lonIncrement * i;

        gridLines.push({
          type: 'Feature',
          geometry: {
            type: 'LineString',
            coordinates: [
              [minLat, thisLon],
              [maxLat, thisLon],
            ],
          },
          id: numSplits + 'gridcol' + i,
        });
        gridLines.push({
          type: 'Feature',
          geometry: {
            type: 'LineString',
            coordinates: [
              [thisLat, minLon],
              [thisLat, maxLon],
            ],
          },
          id: numSplits + 'gridrow' + i,
        });
      }
    }
    return gridLines;
  }


  /**
   * renderPolygons
   * @param  frame        Integer frame being rendered
   * @param  projection   Pixi projection to use for rendering
   * @param  zoom         Effective zoom to use for rendering
   * @param  polygons     Array of polygon data
   */
  renderPolygons(frame, projection, zoom, polygons) {
    const l10n = this.context.systems.l10n;
    const parentContainer = this.scene.groups.get('basemap');

    const polygonStyle = {
      fill: { color: CUSTOM_COLOR, alpha: 0.3, },
      stroke: { width: 2, color: CUSTOM_COLOR, alpha: 1, cap: PIXI.LINE_CAP.ROUND },
      labelTint: CUSTOM_COLOR
    };

    for (const d of polygons) {
      const dataID = d.__featurehash__.toString();
      const version = d.v || 0;
      const parts = (d.geometry.type === 'Polygon') ? [d.geometry.coordinates]
        : (d.geometry.type === 'MultiPolygon') ? d.geometry.coordinates : [];

      for (let i = 0; i < parts.length; ++i) {
        const coords = parts[i];
        const featureID = `${this.layerID}-${dataID}-${i}`;
        let feature = this.features.get(featureID);

        // If feature existed before as a different type, recreate it.
        if (feature && feature.type !== 'polygon') {
          feature.destroy();
          feature = null;
        }

        if (!feature) {
          feature = new PixiFeaturePolygon(this, featureID);
          feature.style = polygonStyle;
          feature.parentContainer = parentContainer;
        }

        // If data has changed.. Replace it.
        if (feature.v !== version) {
          feature.v = version;
          feature.geometry.setCoords(coords);
          feature.label = l10n.displayName(d.properties);
          feature.setData(dataID, d);
        }

        this.syncFeatureClasses(feature);
        feature.update(projection, zoom);
        this.retainFeature(feature, frame);
      }
    }
  }


  /**
   * renderLines
   * @param  frame        Integer frame being rendered
   * @param  projection   Pixi projection to use for rendering
   * @param  zoom         Effective zoom to use for rendering
   * @param  lines        Array of line data
   * @param styleOverride Custom style
   */
  renderLines(frame, projection, zoom, lines, styleOverride) {
    const l10n = this.context.systems.l10n;
    const parentContainer = this.scene.groups.get('basemap');

    const lineStyle = styleOverride || {
      stroke: { width: 2, color: CUSTOM_COLOR, alpha: 1, cap: PIXI.LINE_CAP.ROUND },
      labelTint: CUSTOM_COLOR
    };

    for (const d of lines) {
      const dataID = d.__featurehash__.toString();
      const version = d.v || 0;
      const parts = (d.geometry.type === 'LineString') ? [d.geometry.coordinates]
        : (d.geometry.type === 'MultiLineString') ? d.geometry.coordinates : [];

      for (let i = 0; i < parts.length; ++i) {
        const coords = parts[i];
        const featureID = `${this.layerID}-${dataID}-${i}`;
        let feature = this.features.get(featureID);

        // If feature existed before as a different type, recreate it.
        if (feature && feature.type !== 'line') {
          feature.destroy();
          feature = null;
        }

        if (!feature) {
          feature = new PixiFeatureLine(this, featureID);
          feature.style = lineStyle;
          feature.parentContainer = parentContainer;
        }

        // If data has changed.. Replace it.
        if (feature.v !== version) {
          feature.v = version;
          feature.geometry.setCoords(coords);
          feature.label = l10n.displayName(d.properties);
          feature.setData(dataID, d);
        }

        this.syncFeatureClasses(feature);
        feature.update(projection, zoom);
        this.retainFeature(feature, frame);
      }
    }
  }


  /**
   * renderPoints
   * @param  frame        Integer frame being rendered
   * @param  projection   Pixi projection to use for rendering
   * @param  zoom         Effective zoom to use for rendering
   * @param  lines        Array of point data
   */
  renderPoints(frame, projection, zoom, points) {
    const l10n = this.context.systems.l10n;
    const parentContainer = this.scene.groups.get('points');

    const pointStyle = {
      markerName: 'largeCircle',
      markerTint: CUSTOM_COLOR,
      iconName: 'maki-circle-stroked',
      labelTint: CUSTOM_COLOR
    };

    for (const d of points) {
      const dataID = d.__featurehash__.toString();
      const version = d.v || 0;
      const parts = (d.geometry.type === 'Point') ? [d.geometry.coordinates]
        : (d.geometry.type === 'MultiPoint') ? d.geometry.coordinates : [];

      for (let i = 0; i < parts.length; ++i) {
        const coords = parts[i];
        const featureID = `${this.layerID}-${dataID}-${i}`;
        let feature = this.features.get(featureID);

        // If feature existed before as a different type, recreate it.
        if (feature && feature.type !== 'point') {
          feature.destroy();
          feature = null;
        }

        if (!feature) {
          feature = new PixiFeaturePoint(this, featureID);
          feature.style = pointStyle;
          feature.parentContainer = parentContainer;
        }

        // If data has changed.. Replace it.
        if (feature.v !== version) {
          feature.v = version;
          feature.geometry.setCoords(coords);
          feature.label = l10n.displayName(d.properties);
          feature.setData(dataID, d);
        }

        this.syncFeatureClasses(feature);
        feature.update(projection, zoom);
        this.retainFeature(feature, frame);
      }
    }
  }


  /**
   * template
   * @param  val
   * @param  src
   */
  template(val, src) {
    if (!arguments.length) return this._template;

    // test source against OSM imagery blocklists..
    const osm = this.context.services.osm;
    if (osm) {
      const blocklists = osm.imageryBlocklists ?? [];
      let fail = false;
      let tested = 0;
      let regex;

      for (regex of blocklists) {
        fail = regex.test(val);
        tested++;
        if (fail) break;
      }

      // ensure at least one test was run.
      if (!tested) {
        regex = /.*\.google(apis)?\..*\/(vt|kh)[\?\/].*([xyz]=.*){3}.*/;
        fail = regex.test(val);
      }
    }

    this._template = val;
    this._fileList = null;
    this._geojson = null;

    // strip off the querystring/hash from the template,
    // it often includes the access token
    this._src = src || ('vectortile:' + val.split(/[?#]/)[0]);

    // dispatch.call('change');
    return this;
}


  /**
   * geojson
   * @param  gj
   * @param  src
   */
  geojson(gj, src) {
    if (!arguments.length) return this._geojson;

    this._template = null;
    this._fileList = null;
    this._geojson = null;
    this._src = null;

    gj = gj || {};
    if (Object.keys(gj).length) {
      this._geojson = this._ensureIDs(gj);
      geojsonRewind(this._geojson);
      this._src = src || 'unknown.geojson';
    }

    // dispatch.call('change');
    return this;
  }


  /**
   * fileList
   * @param  fileList
   */
  fileList(fileList) {
    if (!arguments.length) return this._fileList;

    this._template = null;
    this._fileList = fileList;
    this._geojson = null;
    this._src = null;

    if (!fileList || !fileList.length) return this;
    const f = fileList[0];
    const extension = this.getExtension(f.name);
    const setFile = this.setFile;

    const reader = new FileReader();
    reader.onload = (function() {
      return function(e) {
        setFile(extension, e.target.result);
      };
    })(f);
    reader.readAsText(f);

    return this;
  }


  /**
   * url
   * @param  url
   * @param  defaultExtension
   */
  url(url, defaultExtension) {
    this._template = null;
    this._fileList = null;
    this._geojson = null;
    this._src = null;

    // strip off any querystring/hash from the url before checking extension
    const testUrl = url.split(/[?#]/)[0];
    const extension = this.getExtension(testUrl) || defaultExtension;
    if (extension) {
      this._template = null;
      const setFile = this.setFile;
      fetch(url)
        .then(utilFetchResponse)
        .then(data => {
          setFile(extension, data);
          const isTaskBoundsUrl = extension === '.gpx' && url.indexOf('project') > 0 && url.indexOf('task') > 0;
          if (isTaskBoundsUrl) {
            this.context.systems.rapid.setTaskExtentByGpxData(data);
          }
        })
        .catch(e => console.error(e));  // eslint-disable-line
    } else {
      this.template(url);
    }

    return this;
  }


  /**
   * getSrc
   */
  getSrc() {
    return this._src || '';
  }


  /**
   * fitZoom
   */
  fitZoom() {
    const features = this.getFeatures(this._geojson);
    if (!features.length) return;

    const map = this.context.systems.map;
    const viewport = map.trimmedExtent().polygon();

    const coords = features.reduce((coords, feature) => {
      const geom = feature.geometry;
      if (!geom) return coords;

      let c = geom.coordinates;

      /* eslint-disable no-fallthrough */
      switch (geom.type) {
        case 'Point':
          c = [c];
        case 'MultiPoint':
        case 'LineString':
          break;

        case 'MultiPolygon':
          c = utilArrayFlatten(c);
        case 'Polygon':
        case 'MultiLineString':
          c = utilArrayFlatten(c);
          break;
      }
      /* eslint-enable no-fallthrough */

      return utilArrayUnion(coords, c);
    }, []);

    if (!geomPolygonIntersectsPolygon(viewport, coords, true)) {
      const bounds = d3_geoBounds({ type: 'LineString', coordinates: coords });
      const extent = new Extent(bounds[0], bounds[1]);
      map.centerZoom(extent.center(), map.trimmedExtentZoom(extent));
    }

    return this;
  }


  // Ensure that all geojson features in a collection have IDs
  _ensureIDs(geojson) {
    if (!geojson) return null;

    if (geojson.type === 'FeatureCollection') {
      (geojson.features || []).forEach(feature => this._ensureFeatureID(feature));
    } else {
      this._ensureFeatureID(geojson);
    }
    return geojson;
  }

  // ensure that each single Feature object has a unique ID
  _ensureFeatureID(feature) {
    if (!feature) return;
    feature.__featurehash__ = utilHashcode(stringify(feature));
    return feature;
  }


  /**
   * _hashchange
   * Respond to any changes appearing in the url hash
   * @param  currParams   Map(key -> value) of the current hash parameters
   * @param  prevParams   Map(key -> value) of the previous hash parameters
   */
  _hashchange(currParams, prevParams) {
    // gpx
    const newGpx = currParams.get('gpx');
    const oldGpx = prevParams.get('gpx');
    if (newGpx !== oldGpx) {
      this.url(newGpx || '', '.gpx');
    }
  }

}
