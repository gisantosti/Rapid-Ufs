import { Extent, Projection, Tiler, geoZoomToScale, vecAdd } from '@rapid-sdk/math';
import { utilArrayChunk, utilArrayGroupBy, utilArrayUniq, utilObjectOmit, utilQsString } from '@rapid-sdk/util';
import _throttle from 'lodash-es/throttle';
import { osmAuth } from 'osm-auth';
import RBush from 'rbush';

import { AbstractSystem } from '../core/AbstractSystem';
import { JXON } from '../util/jxon';
import { osmEntity, osmNode, osmNote, osmRelation, osmWay } from '../osm';
import { utilFetchResponse } from '../util';


/**
 * `OsmService`
 *
 * Events available:
 *   'apiStatusChange'
 *   'authLoading'
 *   'authDone'
 *   'authchange'
 *   'loading'
 *   'loaded'
 *   'loadedNotes'
 */
export class OsmService extends AbstractSystem {

  /**
   * @constructor
   * @param  `context`  Global shared application context
   */
  constructor(context) {
    super(context);
    this.id = 'osm';

    // Some defaults that we will replace with whatever we fetch from the OSM API capabilities result.
    this._maxWayNodes = 2000;
    this._imageryBlocklists = [/.*\.google(apis)?\..*\/(vt|kh)[\?\/].*([xyz]=.*){3}.*/];
    this._urlroot = 'https://www.openstreetmap.org';

    this._tileCache = { toLoad: {}, loaded: {}, inflight: {}, seen: {}, rtree: new RBush() };
    this._noteCache = { toLoad: {}, loaded: {}, inflight: {}, inflightPost: {}, note: {}, closed: {}, rtree: new RBush() };
    this._userCache = { toLoad: {}, user: {} };
    this._changeset = {};

    this._tiler = new Tiler();
    this._deferred = new Set();
    this._connectionID = 0;
    this._tileZoom = 16;
    this._noteZoom = 12;
    this._rateLimitError = undefined;
    this._userChangesets = undefined;
    this._userDetails = undefined;
    this._cachedApiStatus = undefined;
    this._off = false;

    // Ensure methods used as callbacks always have `this` bound correctly.
    this._authLoading = this._authLoading.bind(this);
    this._authDone = this._authDone.bind(this);
    this._parseNodeJSON = this._parseNodeJSON.bind(this);
    this._parseWayJSON = this._parseWayJSON.bind(this);
    this._parseRelationJSON = this._parseRelationJSON.bind(this);
    this._parseNodeXML = this._parseNodeXML.bind(this);
    this._parseWayXML = this._parseWayXML.bind(this);
    this._parseRelationXML = this._parseRelationXML.bind(this);
    this._parseNoteXML = this._parseNoteXML.bind(this);
    this._parseUserXML = this._parseUserXML.bind(this);

    this.reloadApiStatus = this.reloadApiStatus.bind(this);
    this.throttledReloadApiStatus = _throttle(this.reloadApiStatus, 500);


    const origin = window.location.origin;
    let pathname = window.location.pathname;
    // We often deploy different builds to other pathnames (e.g. /rapid-test/), but we can always
    // redirect to the common /rapid/land.html redirect_uri to complete OAuth2 on that domain.
    if (origin === 'https://mapwith.ai' || origin === 'https://rapideditor.org') {
      pathname = '/rapid/';
    }

    this._oauth = osmAuth({
      url: this._urlroot,
      client_id: 'O3g0mOUuA2WY5Fs826j5tP260qR3DDX7cIIE2R2WWSc',
      client_secret: 'b4aeHD1cNeapPPQTrvpPoExqQRjybit6JBlNnxh62uE',
      scope: 'read_prefs write_prefs write_api read_gpx write_notes',
      redirect_uri: `${origin}${pathname}land.html`,
      loading: this._authLoading,
      done: this._authDone
    });
  }


  /**
   * initAsync
   * Called after all core objects have been constructed.
   * @return {Promise} Promise resolved when this component has completed initialization
   */
  initAsync() {
    return this.resetAsync();
  }


  /**
   * startAsync
   * Called after all core objects have been initialized.
   * @return {Promise} Promise resolved when this component has completed startup
   */
  startAsync() {
    this._started = true;
    return Promise.resolve();
  }


  /**
   * resetAsync
   * Called after completing an edit session to reset any internal state
   * @return {Promise} Promise resolved when this component has completed resetting
   */
  resetAsync() {
    for (const handle of this._deferred) {
      window.cancelIdleCallback(handle);
      this._deferred.delete(handle);
    }

    this._connectionID++;
    this._userChangesets = undefined;
    this._userDetails = undefined;
    this._rateLimitError = undefined;
    this._cachedApiStatus = undefined;

    Object.values(this._tileCache.inflight).forEach(this._abortRequest);
    Object.values(this._noteCache.inflight).forEach(this._abortRequest);
    Object.values(this._noteCache.inflightPost).forEach(this._abortRequest);
    if (this._changeset.inflight) this._abortRequest(this._changeset.inflight);

    this._tileCache = { toLoad: {}, loaded: {}, inflight: {}, seen: {}, rtree: new RBush() };
    this._noteCache = { toLoad: {}, loaded: {}, inflight: {}, inflightPost: {}, note: {}, closed: {}, rtree: new RBush() };
    this._userCache = { toLoad: {}, user: {} };
    this._changeset = {};

    return Promise.resolve();
  }


  /**
   * switchAsync
   * Switch connection and credentials , and reset
   * @return {Promise} Promise resolved when this component has completed resetting
   */
  switchAsync(newOptions) {
    this._urlroot = newOptions.url;

    // Copy the existing options, but omit 'access_token'.
    // (if we did preauth, access_token won't work on a different server)
    const oldOptions = utilObjectOmit(this._oauth.options(), 'access_token');
    this._oauth.options(Object.assign(oldOptions, newOptions));

    return this.resetAsync()
      .then(() => {
// causes major issues for the tests
//        this.userChangesets(function() {});  // eagerly load user details/changesets
        this.emit('authchange');
      });
  }


  toggle(val) {
    this._off = !val;
  }


  isChangesetInflight() {
    return !!this._changeset.inflight;
  }

  get connectionID() {
    return this._connectionID;
  }

  get urlroot() {
    return this._urlroot;
  }

  get imageryBlocklists() {
    return this._imageryBlocklists;
  }

  // Returns the maximum number of nodes a single way can have
  get maxWayNodes() {
    return this._maxWayNodes;
  }


  changesetURL(changesetID) {
    return `${this._urlroot}/changeset/${changesetID}`;
  }


  changesetsURL(center, zoom) {
    const precision = Math.max(0, Math.ceil(Math.log(zoom) / Math.LN2));
    return this._urlroot + '/history#map=' +
      Math.floor(zoom) + '/' +
      center[1].toFixed(precision) + '/' +
      center[0].toFixed(precision);
  }


  entityURL(entity) {
    const entityID = entity.osmId();
    return `${this._urlroot}/${entity.type}/${entityID}`;
  }


  historyURL(entity) {
    const entityID = entity.osmId();
    return `${this._urlroot}/${entity.type}/${entityID}/history`;
  }


  userURL(username) {
    return `${this._urlroot}/user/${username}`;
  }


  noteURL(note) {
    return `${this._urlroot}/note/${note.id}`;
  }


  noteReportURL(note) {
    return `${this._urlroot}/reports/new?reportable_type=Note&reportable_id=${note.id}`;
  }


  // Generic method to load data from the OSM API
  // Can handle either auth or unauth calls.
  loadFromAPI(path, callback, options) {
    options = Object.assign({ skipSeen: true }, options);
    const cid = this._connectionID;

    const done = (err, results) => {
      if (this._connectionID !== cid) {
        if (callback) callback({ message: 'Connection Switched', status: -1 });
        return;
      }

      // 400 Bad Request, 401 Unauthorized, 403 Forbidden
      // Logout and retry the request..
      const isAuthenticated = this.authenticated();
      if (isAuthenticated && (err?.status === 400 || err?.status === 401 || err?.status === 403)) {
        this.logout();
        this.loadFromAPI(path, callback, options);

      // else, no retry..
      } else {
        // 509 Bandwidth Limit Exceeded, 429 Too Many Requests
        // Set the rateLimitError flag and trigger a warning..
        if (!isAuthenticated && !this._rateLimitError && (err?.status === 509 || err?.status === 429)) {
          this._rateLimitError = err;
          this.emit('authchange');
          this.throttledReloadApiStatus();

        } else if ((err && this._cachedApiStatus === 'online') || (!err && this._cachedApiStatus !== 'online')) {
          // If the response's error state doesn't match the status,
          // it's likely we lost or gained the connection so reload the status
          this.throttledReloadApiStatus();
        }

        if (callback) {
          if (err) {
            return callback(err);
          } else {
            if (path.indexOf('.json') !== -1) {
              return this._parseJSON(results, callback, options);
            } else {
              return this._parseXML(results, callback, options);
            }
          }
        }
      }
    };

    const resource = this._urlroot + path;
    const controller = new AbortController();
    const _fetch = this.authenticated() ? this._oauth.fetch : window.fetch;

    _fetch(resource, { signal: controller.signal })
      .then(utilFetchResponse)
      .then(result => done(null, result))
      .catch(err => {
        if (err.name === 'AbortError') return;  // ok
        if (err.name === 'FetchError') {
          done(err);
          return;
        }
      });

    return controller;
  }


  // Load a single entity by id (ways and relations use the `/full` call to include
  // nodes and members). Parent relations are not included, see `loadEntityRelations`.
  // GET /api/0.6/node/#id
  // GET /api/0.6/[way|relation]/#id/full
  loadEntity(id, callback) {
    const type = osmEntity.id.type(id);    // 'node', 'way', 'relation'
    const osmID = osmEntity.id.toOSM(id);
    const options = { skipSeen: false };
    const full = (type !== 'node' ? '/full' : '');

    this.loadFromAPI(
      `/api/0.6/${type}/${osmID}${full}.json`,
      callback,
      options
    );
  }


  // Load a single entity with a specific version
  // GET /api/0.6/[node|way|relation]/#id/#version
  loadEntityVersion(id, version, callback) {
    const type = osmEntity.id.type(id);    // 'node', 'way', 'relation'
    const osmID = osmEntity.id.toOSM(id);
    const options = { skipSeen: false };

    this.loadFromAPI(
      `/api/0.6/${type}/${osmID}/${version}.json`,
      callback,
      options
    );
  }


  // Load the relations of a single entity with the given.
  // GET /api/0.6/[node|way|relation]/#id/relations
  loadEntityRelations(id, callback) {
    const type = osmEntity.id.type(id);
    const osmID = osmEntity.id.toOSM(id);
    const options = { skipSeen: false };

    this.loadFromAPI(
      `/api/0.6/${type}/${osmID}/relations.json`,
      callback,
      options
    );
  }


  // Load multiple entities in chunks
  // (note: callback may be called multiple times)
  // Unlike `loadEntity`, child nodes and members are not fetched
  // GET /api/0.6/[nodes|ways|relations]?#parameters
  loadMultiple(ids, callback) {
    const groups = utilArrayGroupBy(utilArrayUniq(ids), osmEntity.id.type);
    const options = { skipSeen: false };

    for (const [k, vals] of Object.entries(groups)) {
      const type = k + 's';   // nodes, ways, relations
      const osmIDs = vals.map(id => osmEntity.id.toOSM(id));

      for (const arr of utilArrayChunk(osmIDs, 150)) {
        this.loadFromAPI(
          `/api/0.6/${type}.json?${type}=` + arr.join(),
          callback,
          options
        );
      }
    }
  }


  // Create a changeset
  // PUT /api/0.6/changeset/create
  createChangeset(changeset, callback) {
    if (this._changeset.inflight) {
      return callback({ message: 'Changeset already inflight', status: -2 });
    } else if (!this.authenticated()) {
      return callback({ message: 'Not Authenticated', status: -3 });
    }

    const createdChangeset = (err, changesetID) => {
      this._changeset.inflight = null;
      if (err) { return callback(err, changeset); }

      this._changeset.openChangesetID = changesetID;
      changeset = changeset.update({ id: changesetID });
      callback(null, changeset);
    };

    // try to reuse an existing open changeset
    if (this._changeset.openChangesetID) {
      return createdChangeset(null, this._changeset.openChangesetID);
    }

    const errback = this._wrapcb(createdChangeset);
    const resource = this._urlroot + '/api/0.6/changeset/create';
    const controller = new AbortController();
    const options = {
      method: 'PUT',
      headers: { 'Content-Type': 'text/xml' },
      body: JXON.stringify(changeset.asJXON()),
      signal: controller.signal
    };

    this._oauth.fetch(resource, options)
      .then(utilFetchResponse)
      .then(result => errback(null, result))
      .catch(err => {
        this._changeset.inflight = null;
        if (err.name === 'AbortError') return;  // ok
        if (err.name === 'FetchError') {
          errback(err);
          return;
        }
      });

    this._changeset.inflight = controller;
  }


  // Upload changes to a changeset
  // POST /api/0.6/changeset/#id/upload
  uploadChangeset(changeset, changes, callback) {
    if (this._changeset.inflight) {
      return callback({ message: 'Changeset already inflight', status: -2 });
    } else if (!this.authenticated()) {
      return callback({ message: 'Not Authenticated', status: -3 });
    } else if (changeset.id !== this._changeset.openChangesetID) {
      // the given changeset is not open, or a different changeset is open?
      return callback({ message: 'Changeset ID mismatch', status: -4 });
    }

    const uploadedChangeset = (err, /*result*/) => {
      this._changeset.inflight = null;
      // we do get a changeset diff result, but we don't currently use it for anything
      callback(err, changeset);
    };

    const errback = this._wrapcb(uploadedChangeset);
    const resource = this._urlroot + `/api/0.6/changeset/${changeset.id}/upload`;
    const controller = new AbortController();
    const options = {
      method: 'POST',
      headers: { 'Content-Type': 'text/xml' },
      body: JXON.stringify(changeset.osmChangeJXON(changes)),
      signal: controller.signal
    };

    this._oauth.fetch(resource, options)
      .then(utilFetchResponse)
      .then(result => errback(null, result))
      .catch(err => {
        this._changeset.inflight = null;
        if (err.name === 'AbortError') return;  // ok
        if (err.name === 'FetchError') {
          errback(err);
          return;
        }
      });

    this._changeset.inflight = controller;
  }


  // Close a changeset
  // PUT /api/0.6/changeset/#id/close
  closeChangeset(changeset, callback) {
    if (this._changeset.inflight) {
      return callback({ message: 'Changeset already inflight', status: -2 });
    } else if (!this.authenticated()) {
      return callback({ message: 'Not Authenticated', status: -3 });
    } else if (changeset.id !== this._changeset.openChangesetID) {
      // the given changeset is not open, or a different changeset is open?
      return callback({ message: 'Changeset ID mismatch', status: -4 });
    }

    const closedChangeset = (err, /*result*/) => {
      this._changeset.inflight = null;
      this._changeset.openChangesetID = null;
      // there is no result to this call
      callback(err, changeset);
    };

    const errback = this._wrapcb(closedChangeset);
    const resource = this._urlroot + `/api/0.6/changeset/${changeset.id}/close`;
    const controller = new AbortController();
    const options = {
      method: 'PUT',
      headers: { 'Content-Type': 'text/xml' },
      signal: controller.signal
    };

    this._oauth.fetch(resource, options)
      .then(utilFetchResponse)
      .then(result => errback(null, result))
      .catch(err => {
        this._changeset.inflight = null;
        if (err.name === 'AbortError') return;  // ok
        if (err.name === 'FetchError') {
          errback(err);
          return;
        }
      });

    this._changeset.inflight = controller;
  }


  // Just chains together create, upload, and close a changeset
  // PUT /api/0.6/changeset/create
  // POST /api/0.6/changeset/#id/upload
  // PUT /api/0.6/changeset/#id/close
  sendChangeset(changeset, changes, callback) {
    const cid = this._connectionID;

    this.createChangeset(changeset, (err, updated) => {
      changeset = updated;
      if (err) { return callback(err, changeset); }

      this.uploadChangeset(changeset, changes, (err, updated) => {
        changeset = updated;
        if (err) { return callback(err, changeset); }

        // Upload was successful, it is safe to call the callback.
        // Add delay to allow for postgres replication iD#1646 iD#2678
        window.setTimeout(() => {
          this._changeset.openChangesetID = null;
          callback(null, changeset);
        }, 2500);

        // Closing the changeset is optional, and we won't get a result.
        // Only try to close the changeset if we're still talking to the same server.
        if (this.connectionID === cid) {
          this.closeChangeset(changeset, () => {});
        }
      });
    });
  }


  // Load multiple users in chunks
  // (note: callback may be called multiple times)
  // GET /api/0.6/users?users=#id1,#id2,...,#idn
  loadUsers(uids, callback) {
    let toLoad = [];
    let cached = [];

    for (const uid of utilArrayUniq(uids)) {
      if (this._userCache.user[uid]) {  // loaded already
        delete this._userCache.toLoad[uid];
        cached.push(this._userCache.user[uid]);
      } else {
        toLoad.push(uid);
      }
    }

    if (cached.length || !this.authenticated()) {
      callback(undefined, cached);
      if (!this.authenticated()) return;  // require auth
    }

    const gotUsers = (err, results) => {
      if (err) return callback(err);
      callback(undefined, results.data);
    };

    const options = { skipSeen: true };
    for (const arr of utilArrayChunk(toLoad, 150)) {
      this.loadFromAPI(
        '/api/0.6/users.json?users=' + arr.join(),
        gotUsers,
        options
      );
    }
  }


  // Load a given user by id
  // GET /api/0.6/user/#id
  loadUser(uid, callback) {
    if (this._userCache.user[uid] || !this.authenticated()) {   // require auth
      delete this._userCache.toLoad[uid];
      return callback(undefined, this._userCache.user[uid]);
    }

    const gotUsers = (err, results) => {
      if (err) return callback(err);
      callback(undefined, results.data[0]);
    };

    const options = { skipSeen: true };
    this.loadFromAPI(
      `/api/0.6/user/${uid}.json`,
      gotUsers,
      options
    );
  }


  // Load the details of the logged-in user
  // GET /api/0.6/user/details
  userDetails(callback) {
    if (this._userDetails) {    // retrieve cached
      return callback(undefined, this._userDetails);
    }

    const gotUsers = (err, results) => {
      if (err) return callback(err);
      this._userDetails = results.data[0];
      callback(undefined, this._userDetails);
    };

    const options = { skipSeen: false };
    this.loadFromAPI(
      `/api/0.6/user/details.json`,
      gotUsers,
      options
    );
  }


  // Load previous changesets for the logged in user
  // GET /api/0.6/changesets?user=#id
  userChangesets(callback) {
    if (this._userChangesets) {    // retrieve cached
      return callback(undefined, this._userChangesets);
    }

    const gotChangesets = (err, results) => {
      if (err) return callback(err);
      this._userChangesets = results.data;
      return callback(undefined, this._userChangesets);
    };

    const options = { skipSeen: false };
    const gotUser = (err, user) => {
      if (err) return callback(err);
      this.loadFromAPI(
        `/api/0.6/changesets.json?user=${user.id}`,
        gotChangesets,
        options
      );
    };

    this.userDetails(gotUser);
  }


  // Fetch the status of the OSM API
  // GET /api/capabilities
  status(callback) {

    const gotResult = (err, xml) => {
      if (err) {
        return callback(err, null);   // the status is null if no response could be retrieved

      } else if (this._rateLimitError) {
        return callback(this._rateLimitError, 'rateLimited');

      } else {
        // Update blocklists
        let regexes = [];
        for (const element of xml.getElementsByTagName('blacklist')) {
          const regexString = element.getAttribute('regex');  // needs unencode?
          if (regexString) {
            try {
              regexes.push(new RegExp(regexString));
            } catch (e) {
              /* noop */
            }
          }
        }
        if (regexes.length) {
          this._imageryBlocklists = regexes;
        }

        // Update max nodes per way
        const waynodes = xml.getElementsByTagName('waynodes');
        const maxWayNodes = waynodes.length && parseInt(waynodes[0].getAttribute('maximum'), 10);
        if (maxWayNodes && isFinite(maxWayNodes)) {
          this._maxWayNodes = maxWayNodes;
        }

        // Update status
        const apiStatus = xml.getElementsByTagName('status');
        const val = apiStatus[0].getAttribute('api');
        return callback(undefined, val);
      }
    };

    const url = this._urlroot + '/api/capabilities';
    const errback = this._wrapcb(gotResult);

    fetch(url)
      .then(utilFetchResponse)
      .then(result => errback(null, result))
      .catch(err => errback(err));
  }


  // Calls `status` and emits an `apiStatusChange` event if the returned
  // status differs from the cached status.
  reloadApiStatus() {
    this.status((err, status) => {
      if (status !== this._cachedApiStatus) {
        this._cachedApiStatus = status;
        this.emit('apiStatusChange', err, status);
      }
    });
  }


  // Load data (entities) from the API in tiles
  // GET /api/0.6/map?bbox=
  loadTiles(projection, callback) {
    if (this._off) return;

    // determine the needed tiles to cover the view
    const tiles = this._tiler
      .zoomRange(this._tileZoom)
      .margin(1)       // prefetch offscreen tiles as well
      .getTiles(projection)
      .tiles;

    // Abort inflight requests that are no longer needed
    const cache = this._tileCache;
    const hadRequests = this._hasInflightRequests(cache);
    this._abortUnwantedRequests(cache, tiles);
    if (hadRequests && !this._hasInflightRequests(cache)) {
      this.emit('loaded');    // stop the spinner
    }

    // issue new requests..
    for (const tile of tiles) {
      this.loadTile(tile, callback);
    }
  }


  // Load a single data tile
  // GET /api/0.6/map?bbox=
  loadTile(tile, callback) {
    if (this._off) return;

    const cache = this._tileCache;
    if (cache.loaded[tile.id] || cache.inflight[tile.id]) return;

    // exit if this tile covers a blocked region (all corners are blocked)
    const locationSystem = this.context.systems.locations;
    const corners = tile.wgs84Extent.polygon().slice(0, 4);
    const tileBlocked = corners.every(loc => locationSystem.blocksAt(loc).length);
    if (tileBlocked) {
      cache.loaded[tile.id] = true;   // don't try again
      return;
    }

    if (!this._hasInflightRequests(cache)) {
      this.emit('loading');   // start the spinner
    }

    const gotTile = (err, results) => {
      delete cache.inflight[tile.id];
      if (!err) {
        delete cache.toLoad[tile.id];
        cache.loaded[tile.id] = true;
        const bbox = tile.wgs84Extent.bbox();
        bbox.id = tile.id;
        cache.rtree.insert(bbox);
      }
      if (callback) {
        callback(err, Object.assign({}, results, { tile: tile }));
      }
      if (!this._hasInflightRequests(cache)) {
        this.emit('loaded');     // stop the spinner
      }
    };

    const path = '/api/0.6/map.json?bbox=';
    const options = { skipSeen: true };

    cache.inflight[tile.id] = this.loadFromAPI(
      path + tile.wgs84Extent.toParam(),
      gotTile,
      options
    );
  }


  isDataLoaded(loc) {
    const bbox = { minX: loc[0], minY: loc[1], maxX: loc[0], maxY: loc[1] };
    return this._tileCache.rtree.collides(bbox);
  }


  // load the tile that covers the given `loc`
  loadTileAtLoc(loc, callback) {
    const cache = this._tileCache;

    // Back off if the toLoad queue is filling up.. re iD#6417
    // (Currently `loadTileAtLoc` requests are considered low priority - used by operations to
    // let users safely edit geometries which extend to unloaded tiles.  We can drop some.)
    if (Object.keys(cache.toLoad).length > 50) return;

    const k = geoZoomToScale(this._tileZoom + 1);
    const offset = new Projection().scale(k).project(loc);
    const proj = new Projection().transform({ k: k, x: -offset[0], y: -offset[1] });
    const tiles = this._tiler.zoomRange(this._tileZoom).getTiles(proj).tiles;

    for (const tile of tiles) {
      if (cache.toLoad[tile.id] || cache.loaded[tile.id] || cache.inflight[tile.id]) continue;

      cache.toLoad[tile.id] = true;
      this.loadTile(tile, callback);
    }
  }


  // Load notes from the API in tiles
  // GET /api/0.6/notes?bbox=
  loadNotes(projection, noteOptions) {
    if (this._off) return;
    noteOptions = Object.assign({ limit: 10000, closed: 7 }, noteOptions);

    const cache = this._noteCache;
    const that = this;
    const path = '/api/0.6/notes?limit=' + noteOptions.limit + '&closed=' + noteOptions.closed + '&bbox=';
    const deferLoadUsers = _throttle(() => {
      const uids = Object.keys(that._userCache.toLoad);
      if (!uids.length) return;
      that.loadUsers(uids, function() {});  // eagerly load user details
    }, 750);

    // determine the needed tiles to cover the view
    const tiles = this._tiler
      .zoomRange(this._noteZoom)
      .margin(1)       // prefetch offscreen tiles as well
      .getTiles(projection)
      .tiles;

    // abort inflight requests that are no longer needed
    this._abortUnwantedRequests(cache, tiles);

    // issue new requests..
    for (const tile of tiles) {
      if (cache.loaded[tile.id] || cache.inflight[tile.id]) continue;

      // Skip if this tile covers a blocked region (all corners are blocked)
      const locationSystem = this.context.systems.locations;
      const corners = tile.wgs84Extent.polygon().slice(0, 4);
      const tileBlocked = corners.every(loc => locationSystem.blocksAt(loc).length);
      if (tileBlocked) {
        cache.loaded[tile.id] = true;   // don't try again
        continue;
      }

      const options = { skipSeen: false };
      cache.inflight[tile.id] = this.loadFromAPI(
        path + tile.wgs84Extent.toParam(),
        function(err) {
          delete that._noteCache.inflight[tile.id];
          if (!err) {
            that._noteCache.loaded[tile.id] = true;
          }
          // deferLoadUsers();
          that.emit('loadedNotes');
        },
        options
      );
    }
  }


  // Create a note
  // POST /api/0.6/notes?params
  postNoteCreate(note, callback) {
    if (this._noteCache.inflightPost[note.id]) {
      return callback({ message: 'Note update already inflight', status: -2 }, note);
    } else if (!this.authenticated()) {
      return callback({ message: 'Not Authenticated', status: -3 }, note);
    }

    if (!note.loc[0] || !note.loc[1] || !note.newComment) return;  // location & description required

    const createdNote = (err, xml) => {
      delete this._noteCache.inflightPost[note.id];
      if (err) { return callback(err); }

      // we get the updated note back, remove from caches and reparse..
      this.removeNote(note);

      const options = { skipSeen: false };
      return this._parseXML(xml, (err, results) => {
        if (err) {
          return callback(err);
        } else {
          return callback(undefined, results.data[0]);
        }
      }, options);
    };

    const errback = this._wrapcb(createdNote);
    const resource = this._urlroot + '/api/0.6/notes?' +
      utilQsString({ lon: note.loc[0], lat: note.loc[1], text: note.newComment });
    const controller = new AbortController();
    const options = { method: 'POST', signal: controller.signal };

    this._oauth.fetch(resource, options)
      .then(utilFetchResponse)
      .then(result => errback(null, result))
      .catch(err => {
        this._changeset.inflight = null;
        if (err.name === 'AbortError') return;  // ok
        if (err.name === 'FetchError') {
          errback(err);
          return;
        }
      });

    this._noteCache.inflightPost[note.id] = controller;
  }


  // Update a note
  // POST /api/0.6/notes/#id/comment?text=comment
  // POST /api/0.6/notes/#id/close?text=comment
  // POST /api/0.6/notes/#id/reopen?text=comment
  postNoteUpdate(note, newStatus, callback) {
    if (!this.authenticated()) {
      return callback({ message: 'Not Authenticated', status: -3 }, note);
    }
    if (this._noteCache.inflightPost[note.id]) {
      return callback({ message: 'Note update already inflight', status: -2 }, note);
    }

    let action;
    if (note.status !== 'closed' && newStatus === 'closed') {
      action = 'close';
    } else if (note.status !== 'open' && newStatus === 'open') {
      action = 'reopen';
    } else {
      action = 'comment';
      if (!note.newComment) return; // when commenting, comment required
    }

    const updatedNote = (err, xml) => {
      delete this._noteCache.inflightPost[note.id];
      if (err) { return callback(err); }

      // we get the updated note back, remove from caches and reparse..
      this.removeNote(note);

      // update closed note cache - used to populate `closed:note` changeset tag
      if (action === 'close') {
        this._noteCache.closed[note.id] = true;
      } else if (action === 'reopen') {
        delete this._noteCache.closed[note.id];
      }

      const options = { skipSeen: false };
      return this._parseXML(xml, (err, results) => {
        if (err) {
          return callback(err);
        } else {
          return callback(undefined, results.data[0]);
        }
      }, options);
    };

    const errback = this._wrapcb(updatedNote);
    let resource = this._urlroot + `/api/0.6/notes/${note.id}/${action}`;
    if (note.newComment) {
      resource += '?' + utilQsString({ text: note.newComment });
    }
    const controller = new AbortController();
    const options = { method: 'POST', signal: controller.signal };

    this._oauth.fetch(resource, options)
      .then(utilFetchResponse)
      .then(result => errback(null, result))
      .catch(err => {
        this._changeset.inflight = null;
        if (err.name === 'AbortError') return;  // ok
        if (err.name === 'FetchError') {
          errback(err);
          return;
        }
      });

    this._noteCache.inflightPost[note.id] = controller;
  }


  // get/set cached data
  // This is used to save/restore the state when entering/exiting the walkthrough
  // Also used for testing purposes.
  caches(obj) {
    function cloneCache(source) {
      let target = {};
      for (const [k, v] of Object.entries(source)) {
        if (k === 'rtree') {
          target.rtree = new RBush().fromJSON(v.toJSON());  // clone rbush
        } else if (k === 'note') {
          target.note = {};
          for (const id of Object.keys(v)) {
            target.note[id] = osmNote(source.note[id]);   // copy notes
          }
        } else {
          target[k] = JSON.parse(JSON.stringify(v));   // clone deep
        }
      }
      return target;
    }

    if (obj === undefined) {
      return {
        tile: cloneCache(this._tileCache),
        note: cloneCache(this._noteCache),
        user: cloneCache(this._userCache)
      };
    }

    // access caches directly for testing (e.g., loading notes rtree)
    if (obj === 'get') {
      return {
        tile: this._tileCache,
        note: this._noteCache,
        user: this._userCache
      };
    }

    if (obj.tile) {
      this._tileCache = obj.tile;
      this._tileCache.inflight = {};
    }
    if (obj.note) {
      this._noteCache = obj.note;
      this._noteCache.inflight = {};
      this._noteCache.inflightPost = {};
    }
    if (obj.user) {
      this._userCache = obj.user;
    }

    return this;
  }


  logout() {
    this._userChangesets = undefined;
    this._userDetails = undefined;
    this._oauth.logout();
    this.emit('authchange');
    return this;
  }


  authenticated() {
    return this._oauth.authenticated();
  }


  authenticate(callback) {
    const cid = this._connectionID;
    this._userChangesets = undefined;
    this._userDetails = undefined;

    const done = (err, res) => {
      if (err) {
        if (callback) callback(err);
        return;
      }
      if (this._connectionID !== cid) {
        if (callback) callback({ message: 'Connection Switched', status: -1 });
        return;
      }
      this._rateLimitError = undefined;
      this.emit('authchange');
      if (callback) callback(err, res);
      this.userChangesets(function() {});  // eagerly load user details/changesets
    };

    this._oauth.authenticate(done);
  }


  // get all cached notes covering the viewport
  notes(projection) {
    const viewport = projection.dimensions();
    const min = [viewport[0][0], viewport[1][1]];
    const max = [viewport[1][0], viewport[0][1]];
    const bbox = new Extent(projection.invert(min), projection.invert(max)).bbox();

    return this._noteCache.rtree.search(bbox).map(d => d.data);
  }


  // get a single note from the cache
  getNote(id) {
    return this._noteCache.note[id];
  }


  // remove a single note from the cache
  removeNote(note) {
    if (!(note instanceof osmNote) || !note.id) return;

    delete this._noteCache.note[note.id];
    this._updateRtree(this._encodeNoteRtree(note), false);  // false = remove
  }


  // replace a single note in the cache
  replaceNote(note) {
    if (!(note instanceof osmNote) || !note.id) return;

    this._noteCache.note[note.id] = note;
    this._updateRtree(this._encodeNoteRtree(note), true);  // true = replace
    return note;
  }

  // Get an array of note IDs closed during this session.
  // Used to populate `closed:note` changeset tag
  getClosedIDs() {
    return Object.keys(this._noteCache.closed).sort();
  }


  _authLoading() {
    this.emit('authLoading');
  }


  _authDone() {
    this.emit('authDone');
  }


  _abortRequest(controller) {
    if (controller) {
      controller.abort();
    }
  }


  _hasInflightRequests(cache) {
    return Object.keys(cache.inflight).length;
  }


  _abortUnwantedRequests(cache, visibleTiles) {
    for (const k of Object.keys(cache.inflight)) {
      if (cache.toLoad[k]) continue;
      if (visibleTiles.find(tile => tile.id === k)) continue;

      this._abortRequest(cache.inflight[k]);
      delete cache.inflight[k];
    }
  }


  _getLoc(attrs) {
    const lon = attrs.lon?.value;
    const lat = attrs.lat?.value;
    return [ parseFloat(lon), parseFloat(lat) ];
  }


  _getNodes(xml) {
    const elems = Array.from(xml.getElementsByTagName('nd'));
    return elems.map(elem => 'n' + elem.attributes.ref.value);
  }


  _getNodesJSON(obj) {
    return (obj.nodes ?? []).map(nodeID => 'n' + nodeID);
  }


  _getTags(xml) {
    const elems = Array.from(xml.getElementsByTagName('tag'));
    let tags = {};
    for (const elem of elems) {
      const attrs = elem.attributes;
      const k = (attrs.k.value ?? '').trim();
      const v = (attrs.v.value ?? '').trim();
      if (k) {
        tags[k] = v;
      }
    }
    return tags;
  }


  _getMembers(xml) {
    const elems = Array.from(xml.getElementsByTagName('member'));
    return elems.map(elem => {
      const attrs = elem.attributes;
      return {
        id: attrs.type.value[0] + attrs.ref.value,
        type: attrs.type.value,
        role: attrs.role.value
      };
    });
  }


  _getMembersJSON(obj) {
    return (obj.members ?? []).map(member => {
      return {
        id: member.type[0] + member.ref,
        type: member.type,
        role: member.role
      };
    });
  }


  _parseComments(comments) {
    let parsedComments = [];

    for (const comment of comments) {
      if (comment.nodeName === 'comment') {
        let parsedComment = {};

        for (const node of comment.childNodes) {
          const nodeName = node.nodeName;
          if (nodeName === '#text') continue;
          parsedComment[nodeName] = node.textContent;

          if (nodeName === 'uid') {
            const uid = node.textContent;
            if (uid && !this._userCache.user[uid]) {
              this._userCache.toLoad[uid] = true;
            }
          }
        }

        if (Object.keys(parsedComment).length) {
          parsedComments.push(parsedComment);
        }
      }
    }
    return parsedComments;
  }


  _encodeNoteRtree(note) {
    return {
      minX: note.loc[0],
      minY: note.loc[1],
      maxX: note.loc[0],
      maxY: note.loc[1],
      data: note
    };
  }


  /**
   * _parseJSON
   * @param payload
   * @param callback
   * @param options
   */
  _parseJSON(payload, callback, options) {
    options = Object.assign({ skipSeen: true }, options);

    if (!payload)  {
      return callback({ message: 'No JSON', status: -1 });
    }

    let json = payload;
    if (typeof json !== 'object') {
      json = JSON.parse(payload);
    }

    // The payload may contain Elements, Users, or Changesets
    const elements = json.elements ?? [];
    const users = (json.user ? [json.user] : json.users) ?? [];
    const changesets = json?.changesets || [];

    if (!elements || !users || !changesets) {
      return callback({ message: 'No JSON', status: -1 });
    }
    if (elements.some(el => el.type === 'error')) {
      return callback({ message: 'Partial JSON', status: -1 });
    }

    // Defer parsing until later (todo: move all this to a worker)
    const handle = window.requestIdleCallback(() => {
      this._deferred.delete(handle);

      let results = { data: [], seenIDs: new Set() };

      // Parse elements
      for (const element of elements) {
        let parser;
        if (element.type === 'node') {
          parser = this._parseNodeJSON;
        } else if (element.type === 'way') {
          parser = this._parseWayJSON;
        } else if (element.type === 'relation') {
          parser = this._parseRelationJSON;
        }
        if (!parser) continue;

        const uid = osmEntity.id.fromOSM(element.type, element.id);
        results.seenIDs.add(uid);

        if (options.skipSeen) {
          if (this._tileCache.seen[uid]) continue;  // avoid reparsing a "seen" entity
          this._tileCache.seen[uid] = true;
        }

        const parsed = parser(element, uid);
        if (parsed) {
          results.data.push(parsed);
        }
      }

      // Parse users
      for (const user of users) {
        const uid = user.id?.toString();
        if (!uid) continue;

        delete this._userCache.toLoad[uid];
        results.seenIDs.add(uid);

        if (options.skipSeen && this._userCache.user[uid]) {  // avoid reparsing a "seen" entity
          continue;
        }

        const parsed = {
          id: uid,
          display_name: user.display_name,
          account_created: user.account_created,
          image_url: user.img?.href,
          changesets_count: user.changesets?.count?.toString() ?? '0',
          active_blocks: user.blocks?.received?.active?.toString() ?? '0'
        };

        this._userCache.user[uid] = parsed;
        results.data.push(parsed);
      }

      // Parse changesets
      for (const changeset of changesets) {
        if (!changeset?.tags?.comment) continue;   // only include changesets with comment
        results.data.push(changeset);
      }

      callback(null, results);
    });

    this._deferred.add(handle);
  }



  /**
   * _parseXML
   * @param xml
   * @param callback
   * @param options
   */
  _parseXML(xml, callback, options) {
    options = Object.assign({ skipSeen: true }, options);

    if (!xml || !xml.childNodes) {
      return callback({ message: 'No XML', status: -1 });
    }

    const root = xml.childNodes[0];
    const children = Array.from(root.childNodes);
    if (children.some(child => child.nodename === 'error')) {
      return callback({ message: 'Partial XML', status: -1 });
    }

    // Defer parsing until later (todo: move all this to a worker)
    const handle = window.requestIdleCallback(() => {
      this._deferred.delete(handle);

      let results = { data: [], seenIDs: new Set() };

      for (const child of children) {
        let parser;
        if (child.nodeName === 'node') {
          parser = this._parseNodeXML;
        } else if (child.nodeName === 'way') {
          parser = this._parseWayXML;
        } else if (child.nodeName === 'relation') {
          parser = this._parseRelationXML;
        } else if (child.nodeName === 'note') {
          parser = this._parseNoteXML;
        } else if (child.nodeName === 'user') {
          parser = this._parseUserXML;
        }
        if (!parser) continue;

        let uid;
        if (child.nodeName === 'user') {
          uid = child.attributes.id.value;
          results.seenIDs.add(uid);

          if (options.skipSeen && this._userCache.user[uid]) {  // avoid reparsing a "seen" entity
            delete this._userCache.toLoad[uid];
            continue;
          }

        } else if (child.nodeName === 'note') {
          uid = child.getElementsByTagName('id')[0].textContent;
          results.seenIDs.add(uid);

        } else {
          uid = osmEntity.id.fromOSM(child.nodeName, child.attributes.id.value);
          results.seenIDs.add(uid);

          if (options.skipSeen) {
            if (this._tileCache.seen[uid]) continue;  // avoid reparsing a "seen" entity
            this._tileCache.seen[uid] = true;
          }
        }

        const parsed = parser(child, uid);
        if (parsed) {
          results.data.push(parsed);
        }
      }

      callback(null, results);
    });

    this._deferred.add(handle);
  }


  _parseNodeJSON(obj, uid) {
    return new osmNode({
      id:  uid,
      visible: typeof obj.visible === 'boolean' ? obj.visible : true,
      version: obj.version?.toString(),
      changeset: obj.changeset?.toString(),
      timestamp: obj.timestamp,
      user: obj.user,
      uid: obj.uid?.toString(),
      loc: [ parseFloat(obj.lon), parseFloat(obj.lat) ],
      tags: obj.tags
    });
  }

  _parseWayJSON(obj, uid) {
    return new osmWay({
      id:  uid,
      visible: typeof obj.visible === 'boolean' ? obj.visible : true,
      version: obj.version?.toString(),
      changeset: obj.changeset?.toString(),
      timestamp: obj.timestamp,
      user: obj.user,
      uid: obj.uid?.toString(),
      tags: obj.tags,
      nodes: this._getNodesJSON(obj)
    });
  }

  _parseRelationJSON(obj, uid) {
    return new osmRelation({
      id:  uid,
      visible: typeof obj.visible === 'boolean' ? obj.visible : true,
      version: obj.version?.toString(),
      changeset: obj.changeset?.toString(),
      timestamp: obj.timestamp,
      user: obj.user,
      uid: obj.uid?.toString(),
      tags: obj.tags,
      members: this._getMembersJSON(obj)
    });
  }

  _parseNodeXML(xml, uid) {
    const attrs = xml.attributes;
    return new osmNode({
      id: uid,
      visible: (!attrs.visible || attrs.visible.value !== 'false'),
      version: attrs.version.value,
      changeset: attrs.changeset?.value,
      timestamp: attrs.timestamp?.value,
      user: attrs.user?.value,
      uid: attrs.uid?.value,
      loc: this._getLoc(attrs),
      tags: this._getTags(xml)
    });
  }

  _parseWayXML(xml, uid) {
    const attrs = xml.attributes;
    return new osmWay({
      id: uid,
      visible: (!attrs.visible || attrs.visible.value !== 'false'),
      version: attrs.version.value,
      changeset: attrs.changeset?.value,
      timestamp: attrs.timestamp?.value,
      user: attrs.user?.value,
      uid: attrs.uid?.value,
      tags: this._getTags(xml),
      nodes: this._getNodes(xml),
    });
  }

  _parseRelationXML(xml, uid) {
    const attrs = xml.attributes;
    return new osmRelation({
      id: uid,
      visible: (!attrs.visible || attrs.visible.value !== 'false'),
      version: attrs.version.value,
      changeset: attrs.changeset?.value,
      timestamp: attrs.timestamp?.value,
      user: attrs.user?.value,
      uid: attrs.uid?.value,
      tags: this._getTags(xml),
      members: this._getMembers(xml)
    });
  }

  _parseNoteXML(xml, uid) {
    const attrs = xml.attributes;
    const childNodes = xml.childNodes;
    const props = {};

    props.id = uid;
    props.loc = this._getLoc(attrs);

    // if notes are coincident, move them apart slightly
    let coincident = false;
    const epsilon = 0.00001;
    do {
      if (coincident) {
        props.loc = vecAdd(props.loc, [epsilon, epsilon]);
      }
      const bbox = new Extent(props.loc).bbox();
      coincident = this._noteCache.rtree.search(bbox).length;
    } while (coincident);

    // parse note contents
    for (const node of childNodes) {
      const nodeName = node.nodeName;
      if (nodeName === '#text') continue;

      // if the element is comments, parse the comments
      if (nodeName === 'comments') {
        props[nodeName] = this._parseComments(node.childNodes);
      } else {
        props[nodeName] = node.textContent;
      }
    }

    const note = new osmNote(props);
    const item = this._encodeNoteRtree(note);
    this._noteCache.note[note.id] = note;
    this._noteCache.rtree.insert(item);

    return note;
  }


  _parseUserXML(xml, uid) {
    const attrs = xml.attributes;
    let user = {
      id: uid,
      display_name: attrs.display_name?.value,
      account_created: attrs.account_created?.value,
      changesets_count: '0',
      active_blocks: '0'
    };

    const img = xml.getElementsByTagName('img');
    if (img && img[0] && img[0].getAttribute('href')) {
      user.image_url = img[0].getAttribute('href');
    }

    const changesets = xml.getElementsByTagName('changesets');
    if (changesets && changesets[0] && changesets[0].getAttribute('count')) {
      user.changesets_count = changesets[0].getAttribute('count');
    }

    const blocks = xml.getElementsByTagName('blocks');
    if (blocks && blocks[0]) {
      const received = blocks[0].getElementsByTagName('received');
      if (received && received[0] && received[0].getAttribute('active')) {
        user.active_blocks = received[0].getAttribute('active');
      }
    }

    this._userCache.user[uid] = user;
    delete this._userCache.toLoad[uid];
    return user;
  }


  // replace or remove note from rtree
  _updateRtree(item, replace) {
    this._noteCache.rtree.remove(item, (a, b) => a.data.id === b.data.id);

    if (replace) {
      this._noteCache.rtree.insert(item);
    }
  }


  // Wraps an API callback in some additional checks.
  // Logout if we receive 400, 401, 403
  // Raise an error if the connectionID has switched during the API call.
  // @param  callback
  //
  _wrapcb(callback) {
    const cid = this._connectionID;
    return (err, results) => {
      if (err) {
        // 400 Bad Request, 401 Unauthorized, 403 Forbidden..
        if (err.status === 400 || err.status === 401 || err.status === 403) {
          this.logout();
        }
        return callback.call(this, err);

      } else if (this._connectionID !== cid) {
        return callback.call(this, { message: 'Connection Switched', status: -1 });

      } else {
        return callback.call(this, err, results);
      }
    };
  }

}
