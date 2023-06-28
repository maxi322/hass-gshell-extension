const {Soup, Gio, GLib, Secret} = imports.gi;
const Me = imports.misc.extensionUtils.getCurrentExtension();
const MscOptions = Me.imports.settings.MscOptions;

const mscOptions = new MscOptions();
const MyUUID = Me.metadata.uuid;

let TOKEN_SCHEMA;

function getTokenSchema() {
    if (!TOKEN_SCHEMA) {
        TOKEN_SCHEMA = Secret.Schema.new("org.gnome.hass-data.Password",
            Secret.SchemaFlags.NONE,
            {
                "token_string": Secret.SchemaAttributeType.STRING,
            }
        );
    }
    return TOKEN_SCHEMA;
}

const VALID_TOGGLABLES = ['switch.', 'light.', 'fan.', 'input_boolean.'];

/**
 *
 * @param {String} type Request type.
 * @param {String} url Url of the request.
 * @param {Object} data Data in json format.
 * @return {Soup.Message} A soup message with the requested parameters.
 */
function _constructMessage(type, url, data=null) {
    // Initialize message and set the required headers
    // let message = Soup.Message.new_from_encoded_form(
    log(`${MyUUID}: Constructing Message for ${url}`);
    let message = Soup.Message.new(type, url);
    message.request_headers.append(
      'Authorization',
      `Bearer ${Secret.password_lookup_sync(getTokenSchema(), {"token_string": "user_token"}, null)}`
    )
    if (data !== null){
        // Set body data: Should be in json format, e.g. '{"entity_id": "switch.some_relay"}'
        // TODO: Maybe perform a check here
        let bytes2 = GLib.Bytes.new(JSON.stringify(data));
        message.set_request_body_from_bytes('application/json', bytes2);
    }
    message.request_headers.set_content_type("application/json", null);
    return message
}

/**
 *
 * @param {String} url The url which you want to request
 * @param {String} type Request type (e.g. 'GET', 'POST', default: GET)
 * @param {Object} data Data that you want to send with the request (optional, must be in json format, default: null)
 * @param {Function} callback The callback for request result (optional)
 * @param {Function} on_error The callback to run on request error (optional)
 * @return {Object} The response of the request (returns false if the request was unsuccessful)
 */
function send_async_request(url, type, data, callback=null, on_error=null) {
    type = type ? type : 'GET';
    // Initialize session
    let session = Soup.Session.new();
    session.set_timeout(5);
    let message;
    try{
        message = _constructMessage(type, url, data);
    } catch (error) {
        logError(error, `${MyUUID}: Could not construct ${type} message for ${url}`);
        if (on_error) on_error();
        return
    }
    try {
        log(`${MyUUID}: Sending ${type} request on ${url}...`);
        let result = session.send_and_read_async(
            message,
            GLib.PRIORITY_DEFAULT,
            null,
            (session, result) => {
                log(`${MyUUID}: Handling result of ${type} request on ${url}...`);
                if (message.get_status() == Soup.Status.OK) {
                    result = session.send_and_read_finish(result);
                    if (!callback) {
                        log(`${MyUUID}: ${type} request on ${url}: success`);
                        return;
                    }
                    try {
                        log(`${MyUUID}: Decoding result of ${type} request on ${url}..`);
                        let decoder = new TextDecoder('utf-8');
                        let response = decoder.decode(result.get_data());
                        log(`${MyUUID}: run callback for ${type} request on ${url}`);
                        callback(JSON.parse(response));
                    } catch (error) {
                        logError(error, `${MyUUID}: fail to decode result of request on ${url}.`);
                        if (on_error) on_error();
                    }
                }
                else {
                    log(`${MyUUID}: invalid return of request on ${url} (status: ${message.get_status()}`);
                    if (on_error) on_error();
                }
            }
        );
    } catch (error) {
        logError(error, `${MyUUID}: error durring request on ${url}: ${error}`);
        if (on_error) on_error();
    }
}


// Compute HASS URL
function computeURL(path, hass_url=null) {
    let url = hass_url ? hass_url : mscOptions.hassUrl;
    if (!RegExp('^https?://').exec(url))
        url = `http://${url}` // use http:// by default
    if (!path)
        return url
    if (!url.endsWith("/")) url += "/";  //  needs a trailing slash
    return url + path
}

/**
 * Get entities
 *
 * @param {Function} callback The callback to run with the result
 * @param {Function} on_error The callback to run on error
 * @param {Boolean} force_reload Force reloading cache (optional, default: false)
 *
 */
function getEntities(callback, on_error=null, force_reload=false) {
    let entities = mscOptions.entitiesCache;
    if (entities.length == 0 || force_reload) {
        log(`${MyUUID}: get entities from API`);
        send_async_request(
            this.computeURL('api/states'), 'GET', null,
            function (response) {
                if (Array.isArray(response)) {
                    let entities = [];
                    for (let ent of response) {
                        entities.push(
                          {
                            'entity_id': ent.entity_id,
                            'name': ent.attributes.friendly_name,
                            'attributes': ent.attributes,
                            'state': ent.state,
                          }
                        )
                    }
                    log(`${MyUUID}: ${entities.length} entities retreived, sort it by name`);
                    entities = entities.sort((a,b) => (a.name > b.name) ? 1 : ((b.name > a.name) ? -1 : 0));
                    log(`${MyUUID}: update entities cache`);
                    mscOptions.entitiesCache = entities;
                    callback(entities);
                }
                else if (on_error) {
                    on_error();
                }
            }.bind(this),
            on_error
        );
    }
    else {
        log(`${MyUUID}: get entities from cache`);
        callback(entities);
    }
}

/**
 * Invalidate entities cache
 */
function invalidateEntitiesCache() {
    log(`${MyUUID}: invalidate entities cache`);
    mscOptions.entitiesCache = [];
}

/**
 * Get togglables
 *
 * @param {Function} callback The callback to run with the result
 * @param {Function} on_error The callback to run on error
 * @param {Boolean} only_enabled Filter on enabled togglables (optional, default: false)
 * @param {Boolean} force_reload Force reloading cache (optional, default: false)
 *
 */
function getTogglables(callback, on_error=null, only_enabled=false, force_reload=false) {
    getEntities(
        function(entities) {
            let togglables = [];
            for (let ent of entities) {
                if (only_enabled && !mscOptions.enabledEntities.includes(ent.entity_id))
                    continue;
                // Filter on togglable
                if (VALID_TOGGLABLES.filter(tog => ent.entity_id.startsWith(tog)).length == 0)
                    continue;
                togglables.push({'entity_id': ent.entity_id, 'name': ent.name});
            }
            log(`${MyUUID}: ${togglables.length} ${only_enabled?'enabled ':''}togglable entities found`);
            callback(togglables);
        },
        on_error,
        force_reload
    );
}

/**
 * Get sensors
 *
 * @param {Function} callback The callback to run with the result
 * @param {Function} on_error The callback to run on error
 * @param {Boolean} only_enabled Filter on enabled togglables (optional, default: false)
 * @param {Boolean} force_reload Force reloading cache (optional, default: false)
 *
 */
function getSensors(callback, on_error=null, only_enabled=false, force_reload=false) {
    getEntities(
        function(entities) {
            let sensors = [];
            for (let ent of entities) {
                if (only_enabled && !mscOptions.enabledSensors.includes(ent.entity_id))
                    continue;
                if (!ent.entity_id.startsWith('sensor.')) continue;
                if (!ent.state || !ent.attributes.unit_of_measurement) continue;
                if (ent.state === "unknown" || ent.state === "unavailable") continue;
                sensors.push(
                  {
                    'entity_id': ent.entity_id,
                    'name': ent.name,
                    'unit': ent.attributes.unit_of_measurement,
                    'state': ent.state,
                  }
                )
            }
            log(`${MyUUID}: ${sensors.length} ${only_enabled?'enabled ':''}sensor entities found`);
            callback(sensors);
        },
        on_error,
        force_reload
    );
}

/**
 * Get a sensor by its id
 *
 * @param {String} sensor_id The expected sensor ID
 * @param {Function} callback The callback to run with the result
 * @param {Function} on_not_found The callback to run if sensor is not found (or on error)
 * @param {Boolean} force_reload Force reloading cache (optional, default: false)
 *
 */
function getSensor(sensor_id, callback, on_not_found=null, force_reload=false) {
    getSensors(
        function(sensors) {
            for (let sensor of sensors) {
                if (sensor.entity_id == sensor_id) {
                    callback(sensor);
                    return;
                }
            }
            if (on_not_found) on_not_found();
        },
        on_not_found,
        false,
        force_reload
    );
}

/**
 * Compute sensor state as display by the extension
 * @param {String} sensor  The sensor object
 * @return {String} The computed sensor state
 */
function computeSensorState(sensor) {
    return `${sensor.state} ${sensor.unit}`;
}

/**
 * Check equality of elements of two arrays
 * @param {Array} a Array 1
 * @param {Array} b Array 2
 * @return {Boolean} true if the two arrays have the same elements. false otherwise.
 */
function arraysEqual(a, b) {
    if (a === b) return true;
    if (a == null || b == null) return false;
    if (a.length !== b.length) return false;

    // If you don't care about the order of the elements inside
    // the array, you should sort both arrays here.
    // Please note that calling sort on an array will modify that array.
    // you might want to clone your array first.

    for (var i = 0; i < a.length; ++i) {
      if (a[i] !== b[i]) return false;
    }
    return true;
}

/**
 *
 * @param {String} schema_name
 * @return {Gio.Settings} The settings corresponding to the input schema
 */
function getSettings(schema=null) {
    schema = schema ? schema : Me.metadata['settings-schema'];
    const schemaDir = Me.dir.get_child('schemas');
    let schemaSource;
    if (schemaDir.query_exists(null)) {
        schemaSource = Gio.SettingsSchemaSource.new_from_directory(
            schemaDir.get_path(),
            Gio.SettingsSchemaSource.get_default(),
            false
        );
    } else {
        schemaSource = Gio.SettingsSchemaSource.get_default();
    }

    const schemaObj = schemaSource.lookup(schema, true);
    if (!schemaObj) {
        throw new Error(
            'Schema' + schema + ' could not be found for extension ' +
            Me.metadata.uuid + '. Please check your installation.'
        );
    }

    const args = { settings_schema: schemaObj };
    // let path = schema.replace('.', '/');
    // if (path) {
    //     args.path = path;
    // }

    return new Gio.Settings(args);
}

const getMethods = (obj) => {
  let properties = new Set()
  let currentObj = obj
  do {
    Object.getOwnPropertyNames(currentObj).map(item => properties.add(item))
  } while ((currentObj = Object.getPrototypeOf(currentObj)))
  return [...properties.keys()].filter(item => typeof obj[item] === 'function')
}
