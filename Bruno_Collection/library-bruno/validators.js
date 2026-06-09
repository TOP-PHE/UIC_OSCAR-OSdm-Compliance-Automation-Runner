/**
 * validators.js — Swagger/OpenAPI schema-validation helpers + auth-token capture.
 *
 * Loads the OSDM OpenAPI schema and validates request/response payloads and the
 * scenario data file against it; also captures the bearer/access token for the
 * run. Used by scenarioParser (data-file validation) and the response steps.
 */
// Import needed library files
require('./displays.js');


module.exports = {
  setAuthToken,
  captureSwaggerSchemaValidator,
  swaggerSchemaValidatorContent,
  swaggerSchemaValidator,
  validateDataFileJsonWithTemplate
};

function resolveAjvConstructor() {
  try {
    const AjvModule = require("ajv");
    return AjvModule.default || AjvModule;
  } catch (e) {
    // Fallback to env-provided AJV script in Bruno sandbox environments.
  }

  const scriptContent = bru.getEnvVar("scriptContent");
  if (!scriptContent) {
    throw new Error("AJV scriptContent not found in env and local 'ajv' dependency is unavailable");
  }

  const factory = new Function(`${String(scriptContent)}; return typeof Ajv !== 'undefined' ? Ajv : null;`);
  const AjvFromScript = factory();
  if (!AjvFromScript) {
    throw new Error("AJV constructor was not exported by scriptContent");
  }
  return AjvFromScript;
}

// Function to set the authentication token
function setAuthToken(responseBody) {
  try {
    let jsonData;
    validationLogger("[INFO] Token Resp body", jsonData);
    if (responseBody) {
      jsonData = typeof responseBody === 'string' ? JSON.parse(responseBody) : responseBody;
    } else if (typeof res !== 'undefined' && typeof res.getBody === 'function') {
      jsonData = res.getBody(); // Bruno test script context
    } else {
      validationLogger("[WARNING] setAuthToken called without response body; skipping");
      return;
    }
    if (jsonData && jsonData.access_token) {
      bru.setEnvVar(GV.ACCESS_TOKEN, jsonData.access_token);
      validationLogger("[INFO] Access token set");
    } else {
      validationLogger("[WARNING] PHE access_token not found in response");
    }
  } catch (e) {
    console.error("setAuthToken error:", e && e.stack ? e.stack : e);
  }
}

function captureSwaggerSchemaValidator() {
  validationLogger("[INFO] ⏳ swaggerSchemaValidator");

  const url = bru.getEnvVar("swaggerSchema");
  if (!url) {
    console.error("❌ Missing env var swaggerSchema");
    return;
  }

  bru.sendRequest(
    { url, method: 'GET', proxy: false },
    function (err, res) {
      if (err) {
        console.log("❌ Error during Swagger request:", err);
        return;
      }
      try {
        const status = res.status || res.statusCode || 200;
        const body = res.data;
        if (status >= 200 && status < 300 && body) {
          const swaggerJson = typeof body === 'string' ? JSON.parse(body) : body;
          const swaggerJsonString = JSON.stringify(swaggerJson);
          bru.setEnvVar("swaggerJson", swaggerJsonString);
          console.log("✅ Swagger JSON captured");
        } else {
          console.error(`❌ Swagger load failed: HTTP ${status}`);
        }
      } catch (e) {
        console.error("❌ Failed to parse Swagger JSON:", e);
      }
    }
  );
}

function swaggerSchemaValidatorContent() {
  const ajvUrl = bru.getEnvVar("ajvMinified");
  if (!ajvUrl) {
    console.error("❌ Missing env var ajvMinified");
    return;
  }

  bru.sendRequest(
    { url: ajvUrl, method: 'GET', proxy: false },
    function (err, res) {
      if (err) {
        console.log("❌ Error while loading AJV:", err);
        return;
      }

      try {
        const status = res.status || res.statusCode || 200;
        const text = res.data || "";
        if (status >= 200 && status < 300 && String(text).length > 0) {
          console.log("✅ AJV script successfully loaded");
          const scriptContent = String(text);
          bru.setEnvVar("scriptContent", scriptContent);

          const swaggerJsonString = bru.getEnvVar("swaggerJson");
          if (!swaggerJsonString) {
            console.error("❌ swaggerJson env var is missing; run captureSwaggerSchemaValidator first");
            return;
          }
          const swaggerSchema = JSON.parse(swaggerJsonString);

          swaggerSchemaValidator({
            schema: swaggerSchema,
            requestHeaders: bru.getEnvVar("requestHeaders"),
            requestBody: bru.getEnvVar("OfferCollectionRequest"),
            responseHeaders: bru.getEnvVar("responseHeaders"),
            responseBody: bru.getEnvVar("responseBody"),
            method: bru.getEnvVar("method"),
            url: bru.getEnvVar("url")
          });
        } else {
          console.error(`❌ Failed to load AJV script. HTTP ${status}`);
        }
      } catch (e) {
        console.error("❌ Error during AJV script evaluation/usage:", e);
      }
    }
  );
}

function swaggerSchemaValidator({ schema, requestHeaders, requestBody, responseHeaders, responseBody, method, url }) {
  try {
    function resolveRef(ref, rootSchema) {
      if (!ref || !ref.startsWith('#/')) return null;
      const path = ref.slice(2).split('/');
      return path.reduce((obj, key) => obj && obj[key], rootSchema);
    }

    const baseUrlPattern = /{{\s*api_base\s*}}/g;
    const cleanedUrl = String(url || "").replace(baseUrlPattern, "");
    const urlParts = cleanedUrl.split('?')[0];
    const pathList = Object.keys(schema.paths || {});

    let matchedPath = null;
    for (let path of pathList) {
      const regex = new RegExp("^" + path.replace(/{[^}]+}/g, "[^/]+") + "$");
      if (regex.test(urlParts)) {
        matchedPath = path;
        break;
      }
    }

    if (!matchedPath) {
      console.error(`❌ No matching path found in Swagger for URL: ${url}`);
      return;
    }

    const m = String(method || "").toLowerCase();
    const pathSchema = schema.paths[matchedPath]?.[m];
    if (!pathSchema) {
      console.error(`❌ No matching method '${method}' for path '${matchedPath}'`);
      return;
    }

    let Ajv;
    try {
      Ajv = resolveAjvConstructor();
    } catch (e) {
      console.error("❌ Failed to initialize AJV:", e && e.message ? e.message : e);
      return;
    }

    // Request body validation
    if (pathSchema.requestBody?.content?.["application/json"]) {
      let bodySchema = pathSchema.requestBody.content["application/json"].schema;
      if (bodySchema && bodySchema.$ref) {
        bodySchema = resolveRef(bodySchema.$ref, schema);
      }

      try {
        const ajv = new Ajv();
        const validateBody = ajv.compile(bodySchema);
        let bodyToValidate = requestBody;
        if (typeof bodyToValidate === 'string') {
          bodyToValidate = JSON.parse(bodyToValidate);
        }
        const valid = validateBody(bodyToValidate);
        if (!valid) {
          console.error(`❌ Invalid request body for ${method} ${matchedPath}:`, validateBody.errors);
        } else {
          console.log(`✅ Request body is valid for ${method} ${matchedPath}`);
        }
      } catch (e) {
        console.error("❌ Failed to validate request body:", e);
      }
    }

    // Response body validation (200 application/json)
    let responseSchema = pathSchema.responses?.["200"]?.content?.["application/json"]?.schema;
    if (responseSchema) {
      if (responseSchema.$ref) {
        responseSchema = resolveRef(responseSchema.$ref, schema);
      }

      try {
        const ajv = new Ajv();
        const validateResponse = ajv.compile(responseSchema);
        let bodyToValidate = responseBody;
        if (typeof bodyToValidate === 'string') {
          bodyToValidate = JSON.parse(bodyToValidate);
        }
        const valid = validateResponse(bodyToValidate);
        if (!valid) {
          console.error(`❌ Invalid response body for ${method} ${matchedPath}:`, validateResponse.errors);
        } else {
          console.log(`✅ Response body is valid for ${method} ${matchedPath}`);
        }
      } catch (e) {
        console.error("❌ Failed to validate response body:", e);
      }
    }
  } catch (e) {
    console.error("swaggerSchemaValidator error:", e && e.stack ? e.stack : e);
  }
}

// Function to validate JSON with a template schema manually
function validateDataFileJsonWithTemplate(jsonData) {
  const schemaUrl = bru.getEnvVar("json_schema");
  if (!schemaUrl) {
    console.error("❌ Missing env var json_schema");
    test("Schema load failed", function () {
      throw new Error("Schema load failed: json_schema env var missing");
    });
    return;
  }

  // #328 (v1.11.109): warn about stale schema URLs. Several pre-existing
  // env files point at the external GitHub repo OSDM-testing/refs/heads/
  // exch_dev/json_validator/datafile.schema.json — that branch has been
  // deprecated and its schema is OUT OF SYNC with what the wizard
  // produces (it still requires the legacy offerSearchCriteriaList +
  // offerSearchCriteriaListId linkage, but OSCAR's modern datafiles
  // use the inline scenario.offerSearchCriteria model). Validating
  // against the stale schema produces false-positive failures that
  // mislead new users.
  //
  // The canonical local schema is bundled with OSCAR at
  //   http://localhost:8080/json_validator/datafile.schema.json
  // and that's what every fresh env file should reference. When we
  // detect the GitHub URL we emit a [WARNING] naming both the issue
  // and the fix, so the new user has a clear next step instead of
  // chasing "Required property 'offerSearchCriteriaList' is missing"
  // through the codebase.
  // Use URL.hostname so we match the host CORRECTLY (CodeQL
  // js/regex/missing-regexp-anchor — a bare /github\.com/ would also
  // match strings like `https://evilgithub.com.attacker.example/`).
  try {
    if (typeof schemaUrl === "string") {
      let _hostname = "";
      try { _hostname = new URL(schemaUrl).hostname || ""; } catch (_urlErr) { _hostname = ""; }
      // Match the GitHub hosts we know to warn about, anchored to the
      // full hostname extracted from the URL. Covers:
      //   - github.com
      //   - raw.githubusercontent.com  (the actual host for refs/heads/... paths)
      //   - any other *.github.com / *.githubusercontent.com subdomain
      const _isGitHubHost = /^(?:[^.]+\.)?github(?:usercontent)?\.com$/i.test(_hostname);
      if (_isGitHubHost) {
        // #333 (v1.11.112): json_schema is a SERVER-wide setting, not a
        // per-company env file. The previous WARNING text said "update the
        // company's environment file" which is misleading — there is no
        // such file. The value comes from JSON_SCHEMA_URL set on the OSCAR
        // server's .env (OSCAR_Deploy/.env). v1.11.112 also serves the
        // schema bundled with the Bruno collection at
        // http://127.0.0.1:3001/json_validator/datafile.schema.json, so
        // operators no longer need a public schema URL at all.
        const _isExchDev = /exch_dev/i.test(schemaUrl) || /OSDM-testing/i.test(schemaUrl);
        const _staleNote = _isExchDev
          ? 'The UnionInternationalCheminsdeFer/OSDM-testing repo (exch_dev branch and others) is deprecated as a schema reference — its schema is out of sync with the modern OSCAR datafile shape and produces false-positive validation failures (typically "Required property \'offerSearchCriteriaList\' is missing"). '
          : 'A GitHub-hosted schema URL is fragile (depends on the repo staying public and the branch / file path not moving). ';
        validationLogger(
          '[WARNING] json_schema env var points at a GitHub-hosted schema (' + schemaUrl + '). ' +
          _staleNote +
          'OSCAR_Server now bundles the schema and serves it locally — preferred value: ' +
          'http://127.0.0.1:3001/json_validator/datafile.schema.json. ' +
          'Operator action on the VPS: edit OSCAR_Deploy/.env, set JSON_SCHEMA_URL to that URL, restart with "docker compose restart oscar".'
        );
      }
    }
  } catch (_logErr) { /* logging is best-effort */ }

  bru.sendRequest(
    { url: schemaUrl, method: 'GET', proxy: false },
    function (err, res) {
      if (err) {
        console.error("Error loading the schema: ", err);
        test("Schema load failed", function () {
          throw new Error("Schema load failed: " + err);
        });
        return;
      }

      try {
        const status = res.status || res.statusCode || 200;
        if (status < 200 || status >= 300) {
          test("Schema load failed (HTTP)", function () {
            throw new Error(`Schema load HTTP error: ${status}`);
          });
          return;
        }

        const schema = typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
        let validationErrors = [];

        function validateType(type, value) {
          if (type === "string") return typeof value === "string";
          if (type === "integer") return Number.isInteger(value);
          if (type === "boolean") return typeof value === "boolean";
          if (type === "object") return value !== null && typeof value === "object" && !Array.isArray(value);
          if (type === "array") return Array.isArray(value);
          if (type === "null") return value === null;
          if (type === "number") return typeof value === "number" && !Number.isNaN(value);
          return false;
        }

        function validateValueAgainstSchema(key, value, propertySchema, path = "") {
          const fullPath = path ? (key ? `${path}.${key}` : path) : key;

          // Check required
          if (value == null) {
            if (
              key === "gender" || key === "updateGender" || key === "requiresPlaceSelection" || key === "offerMode" ||
              key === "updateFirstName" || key === "updateLastName" || key === "updateDateOfBirth" ||
              key === "updatePhoneNumber" || key === "updateEmail" || key === "requestedOfferParts" ||
              key === "serviceClass" || key === "travelClass" || key === "refundDate" || key === "flexibilities" ||
              key === "desiredFlexibility" || key === "overruleCode" || key === "scenarioAction" ||
              key === "accommodationSelection" || key === "loggingType"
            ) {
              validationLogger(`[FULL] ⚠️ Optional field '${fullPath}' is null/missing — this is allowed.`);
              return;
            }
            validationErrors.push(`❌ Required property '${fullPath}' is missing.`);
            return;
          }

          // Type
          const expectedTypes = Array.isArray(propertySchema.type)
            ? propertySchema.type
            : [propertySchema.type];

          const typeIsValid = expectedTypes.some(t => validateType(t, value));
          if (!typeIsValid) {
            validationErrors.push(`❌ '${fullPath}' has invalid type. Expected: ${expectedTypes.join(", ")}.`);
            return;
          }

          // Enum
          if (propertySchema.enum && !propertySchema.enum.includes(value)) {
            validationErrors.push(`❌ '${fullPath}' has value '${value}' not in enum: ${propertySchema.enum.join(", ")}.`);
          }

          // String constraints
          if (typeof value === "string") {
            if (propertySchema.minLength && value.length < propertySchema.minLength) {
              validationErrors.push(`❌ '${fullPath}' is too short (minLength: ${propertySchema.minLength}).`);
            }
            if (propertySchema.maxLength && value.length > propertySchema.maxLength) {
              validationErrors.push(`❌ '${fullPath}' is too long (maxLength: ${propertySchema.maxLength}).`);
            }
          }

          // Object properties
          if (propertySchema.type === "object" && propertySchema.properties) {
            const requiredFields = propertySchema.required || [];
            for (let subKey in propertySchema.properties) {
              if (value.hasOwnProperty(subKey)) {
                validateValueAgainstSchema(
                  subKey,
                  value[subKey],
                  propertySchema.properties[subKey],
                  fullPath
                );
              }

            }
            for (let reqKey of requiredFields) {
              if (!(reqKey in value)) {
                validationErrors.push(`❌ Required field '${fullPath}.${reqKey}' is missing.`);
              }
            }
          }

          // Array items
          if (propertySchema.type === "array" && propertySchema.items) {
            if (!Array.isArray(value)) {
              validationErrors.push(`❌ '${fullPath}' should be an array.`);
            } else {
              value.forEach((item, index) => {
                const arrayItemPath = `${fullPath}[${index}]`;
                validateValueAgainstSchema(
                  '',
                  item,
                  propertySchema.items,
                  arrayItemPath
                );
              });
            }
          }
        }

        function validateJsonObject(json, schema, path = "") {
          const requiredFields = schema.required || [];
          for (let key of requiredFields) {
            if (!(key in json)) {
              validationErrors.push(`❌ Required property '${path ? path + '.' : ''}${key}' is missing.`);
            }
          }
          for (let key in (schema.properties || {})) {
            if (json.hasOwnProperty(key)) {
              validateValueAgainstSchema(key, json[key], schema.properties[key], path);
            }
          }
        }

        validateJsonObject(jsonData, schema);

        if (validationErrors.length === 0) {
          validationLogger(`[INFO] ✅ JSON Data file structure validation passed with schema from : ${schemaUrl}`);
          test("JSON Data file structure validation passed", function () {
            expect(true).to.eql(true);
          });
        } else {
          validationLogger(`[INFO] ⛔ Invalid JSON Data file structure with schema from : ${schemaUrl}`);
          validationErrors.forEach(err => console.error(err));
          test("⛔ Invalid JSON Data file structure", function () {
            throw new Error("Validation errors:\n" + validationErrors.join("\n"));
          });
        }
      } catch (e) {
        console.error("Schema parsing/validation error:", e);
        test("Schema parse/validate failure", function () {
          throw new Error("Schema parse/validate failure: " + (e.message || e));
        });
      }
    }
  );
}

// Expose to global for convenience
try {
  Object.assign(globalThis, module.exports);
} catch (e) {
  // no-op
}