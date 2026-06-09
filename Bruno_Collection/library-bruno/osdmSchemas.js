/*
Copyright UIC, Union Internationale des Chemins de fer
Licensed under the Apache License, Version 2.0 (the "License");
http://www.apache.org/licenses/LICENSE-2.0
*/

/**
 * osdmSchemas.js — compact, version-matched OSDM System-Information schemas
 * ========================================================================
 * GENERATED FILE — do not hand-edit. Compact JSON-Schema-style descriptors for
 * the System-Information response components, one set per published OSDM
 * version (v3.4-v3.8). Used by osdmSchema.js for Layer-2 (deep, version-matched)
 * compliance validation, selected via getComplianceVersion().
 *
 * Generation (from https://github.com/UnionInternationalCheminsdeFer/OSDM
 *   gh-pages/specification/v<X>/OSDM-online-api-v<X>.0.yml):
 *   - resolve $ref; bound depth to 2 levels (top + one nested level);
 *   - x-extensible-enum -> plain string (OSDM permits values beyond the list);
 *   - oneOf/anyOf (polymorphic) -> relaxed to { type: 'object' };
 *   - allOf -> merged; circular refs -> relaxed to { type: 'object' }.
 * To regenerate after a spec bump, re-run the generator (see #105 Stage 3).
 */

'use strict';

const schemas = {
  "3.4.0": {
    "CoachLayout": {
      "type": "object",
      "required": [
        "id",
        "gridSize"
      ],
      "properties": {
        "id": {
          "type": "string"
        },
        "summary": {
          "type": "string"
        },
        "places": {
          "type": "array",
          "items": {
            "type": "object"
          }
        },
        "signs": {
          "type": "array",
          "items": {
            "type": "object"
          }
        },
        "internals": {
          "type": "array",
          "items": {
            "type": "object"
          }
        },
        "directedInternals": {
          "type": "array",
          "items": {
            "type": "object"
          }
        },
        "compartmentNumbers": {
          "type": "array",
          "items": {
            "type": "object"
          }
        },
        "gridSize": {
          "type": "object",
          "required": [
            "x",
            "y"
          ],
          "properties": {
            "x": {
              "type": "integer"
            },
            "y": {
              "type": "integer"
            }
          }
        },
        "_links": {
          "type": "array",
          "items": {
            "type": "object"
          }
        }
      }
    },
    "ReductionCardType": {
      "type": "object",
      "required": [
        "code",
        "issuer",
        "name"
      ],
      "properties": {
        "code": {
          "type": "string"
        },
        "shortCode": {
          "type": "string"
        },
        "issuer": {
          "type": "string"
        },
        "name": {
          "type": "object",
          "required": [
            "id",
            "text"
          ],
          "properties": {
            "id": {
              "type": "string"
            },
            "translations": {
              "type": "array"
            },
            "text": {
              "type": "string"
            },
            "shortText": {
              "type": "string"
            }
          }
        },
        "cardIdRequired": {
          "type": "boolean"
        },
        "includedCardTypes": {
          "type": "array",
          "items": {
            "type": "object"
          }
        },
        "serviceClassTypes": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "_links": {
          "type": "array",
          "items": {
            "type": "object"
          }
        }
      }
    },
    "ZoneDefinition": {
      "type": "object",
      "required": [
        "id",
        "carrier"
      ],
      "properties": {
        "id": {
          "type": "string"
        },
        "name": {
          "type": "string"
        },
        "carrier": {
          "type": "string"
        },
        "polygon": {
          "type": "object",
          "required": [
            "edges"
          ],
          "properties": {
            "edges": {
              "type": "array"
            }
          }
        },
        "nutsCodes": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "places": {
          "type": "array",
          "items": {
            "type": "object"
          }
        }
      }
    },
    "PromotionCode": {
      "type": "object",
      "required": [
        "code"
      ],
      "properties": {
        "code": {
          "type": "string"
        },
        "issuer": {
          "type": "string"
        }
      }
    },
    "Product": {
      "type": "object",
      "required": [
        "id",
        "code",
        "owner",
        "flexibility"
      ],
      "properties": {
        "id": {
          "type": "string"
        },
        "summary": {
          "type": "string"
        },
        "type": {
          "type": "string"
        },
        "code": {
          "type": "string"
        },
        "description": {
          "type": "string"
        },
        "owner": {
          "type": "string"
        },
        "conditions": {
          "type": "array",
          "items": {
            "type": "object"
          }
        },
        "flexibility": {
          "type": "string"
        },
        "serviceClass": {
          "type": "object",
          "required": [
            "type",
            "name"
          ],
          "properties": {
            "type": {
              "type": "string"
            },
            "name": {
              "type": "string"
            }
          }
        },
        "travelClass": {
          "type": "string"
        },
        "fulfillmentOptions": {
          "type": "array",
          "items": {
            "type": "object"
          }
        },
        "isTrainBound": {
          "type": "boolean"
        },
        "isReturnProduct": {
          "type": "boolean"
        },
        "serviceConstraintText": {
          "type": "string"
        },
        "carrierConstraintText": {
          "type": "string"
        },
        "descriptiveTexts": {
          "type": "array",
          "items": {
            "type": "object"
          }
        },
        "tariff": {
          "type": "string"
        },
        "combinationTags": {
          "type": "array",
          "items": {
            "type": "object"
          }
        },
        "productTags": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "_links": {
          "type": "array",
          "items": {
            "type": "object"
          }
        }
      }
    }
  },
  "3.5.0": {
    "CoachLayout": {
      "type": "object",
      "required": [
        "id",
        "gridSize"
      ],
      "properties": {
        "id": {
          "type": "string"
        },
        "summary": {
          "type": "string"
        },
        "places": {
          "type": "array",
          "items": {
            "type": "object"
          }
        },
        "signs": {
          "type": "array",
          "items": {
            "type": "object"
          }
        },
        "internals": {
          "type": "array",
          "items": {
            "type": "object"
          }
        },
        "directedInternals": {
          "type": "array",
          "items": {
            "type": "object"
          }
        },
        "compartmentNumbers": {
          "type": "array",
          "items": {
            "type": "object"
          }
        },
        "gridSize": {
          "type": "object",
          "required": [
            "x",
            "y"
          ],
          "properties": {
            "x": {
              "type": "integer"
            },
            "y": {
              "type": "integer"
            }
          }
        },
        "_links": {
          "type": "array",
          "items": {
            "type": "object"
          }
        }
      }
    },
    "CoachDeckLayout": {
      "type": "object",
      "required": [
        "name",
        "dimension",
        "id",
        "deckLevel"
      ],
      "properties": {
        "name": {
          "type": "string"
        },
        "dimension": {
          "type": "object",
          "required": [
            "width",
            "height"
          ],
          "properties": {
            "width": {
              "type": "integer"
            },
            "height": {
              "type": "integer"
            },
            "borderRadius": {
              "type": "object"
            }
          }
        },
        "lowFloorEntry": {
          "type": "boolean"
        },
        "id": {
          "type": "string"
        },
        "deckLevel": {
          "type": "string"
        },
        "placeGroups": {
          "type": "array",
          "items": {
            "type": "object"
          }
        },
        "graphicElements": {
          "type": "array",
          "items": {
            "type": "object"
          }
        },
        "serviceIcons": {
          "type": "array",
          "items": {
            "type": "object"
          }
        }
      }
    },
    "ReductionCardType": {
      "type": "object",
      "required": [
        "code",
        "issuer",
        "name"
      ],
      "properties": {
        "code": {
          "type": "string"
        },
        "shortCode": {
          "type": "string"
        },
        "issuer": {
          "type": "string"
        },
        "name": {
          "type": "object",
          "required": [
            "id",
            "text"
          ],
          "properties": {
            "id": {
              "type": "string"
            },
            "translations": {
              "type": "array"
            },
            "text": {
              "type": "string"
            },
            "shortText": {
              "type": "string"
            }
          }
        },
        "cardIdRequired": {
          "type": "boolean"
        },
        "includedCardTypes": {
          "type": "array",
          "items": {
            "type": "object"
          }
        },
        "serviceClassTypes": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "reductionsGranted": {
          "type": "array",
          "items": {
            "type": "object"
          }
        },
        "_links": {
          "type": "array",
          "items": {
            "type": "object"
          }
        }
      }
    },
    "ZoneDefinition": {
      "type": "object",
      "required": [
        "id",
        "carrier"
      ],
      "properties": {
        "id": {
          "type": "string"
        },
        "name": {
          "type": "string"
        },
        "carrier": {
          "type": "string"
        },
        "polygon": {
          "type": "object",
          "required": [
            "edges"
          ],
          "properties": {
            "edges": {
              "type": "array"
            }
          }
        },
        "nutsCodes": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "places": {
          "type": "array",
          "items": {
            "type": "object"
          }
        }
      }
    },
    "PromotionCode": {
      "type": "object",
      "required": [
        "code"
      ],
      "properties": {
        "code": {
          "type": "string"
        },
        "issuer": {
          "type": "string"
        }
      }
    },
    "ProductTagName": {
      "type": "object",
      "required": [
        "tag",
        "description"
      ],
      "properties": {
        "tag": {
          "type": "string"
        },
        "description": {
          "type": "object",
          "required": [
            "id",
            "text"
          ],
          "properties": {
            "id": {
              "type": "string"
            },
            "translations": {
              "type": "array"
            },
            "text": {
              "type": "string"
            },
            "shortText": {
              "type": "string"
            }
          }
        }
      }
    },
    "ProductTagGroup": {
      "type": "object",
      "required": [
        "code",
        "description"
      ],
      "properties": {
        "code": {
          "type": "string"
        },
        "description": {
          "type": "object",
          "required": [
            "id",
            "text"
          ],
          "properties": {
            "id": {
              "type": "string"
            },
            "translations": {
              "type": "array"
            },
            "text": {
              "type": "string"
            },
            "shortText": {
              "type": "string"
            }
          }
        },
        "productTags": {
          "type": "array",
          "items": {
            "type": "string"
          }
        }
      }
    },
    "Product": {
      "type": "object",
      "required": [
        "id",
        "code",
        "owner",
        "flexibility"
      ],
      "properties": {
        "id": {
          "type": "string"
        },
        "summary": {
          "type": "string"
        },
        "type": {
          "type": "string"
        },
        "code": {
          "type": "string"
        },
        "description": {
          "type": "string"
        },
        "owner": {
          "type": "string"
        },
        "conditions": {
          "type": "array",
          "items": {
            "type": "object"
          }
        },
        "flexibility": {
          "type": "string"
        },
        "serviceClass": {
          "type": "object",
          "required": [
            "type",
            "name"
          ],
          "properties": {
            "type": {
              "type": "string"
            },
            "name": {
              "type": "string"
            }
          }
        },
        "travelClass": {
          "type": "string"
        },
        "fulfillmentOptions": {
          "type": "array",
          "items": {
            "type": "object"
          }
        },
        "isTrainBound": {
          "type": "boolean"
        },
        "isReturnProduct": {
          "type": "boolean"
        },
        "serviceConstraintText": {
          "type": "string"
        },
        "carrierConstraintText": {
          "type": "string"
        },
        "descriptiveTexts": {
          "type": "array",
          "items": {
            "type": "object"
          }
        },
        "tariff": {
          "type": "string"
        },
        "combinationTags": {
          "type": "array",
          "items": {
            "type": "object"
          }
        },
        "productTags": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "_links": {
          "type": "array",
          "items": {
            "type": "object"
          }
        }
      }
    }
  },
  "3.6.0": {
    "ApiVersion": {
      "type": "object",
      "required": [
        "version"
      ],
      "properties": {
        "version": {
          "type": "string"
        },
        "sunset": {
          "type": "string"
        },
        "nextVersion": {
          "type": "object",
          "properties": {
            "version": {
              "type": "string"
            },
            "availableAt": {
              "type": "string"
            },
            "availableFrom": {
              "type": "string"
            }
          }
        }
      }
    },
    "CoachLayout": {
      "type": "object",
      "required": [
        "id",
        "gridSize"
      ],
      "properties": {
        "id": {
          "type": "string"
        },
        "summary": {
          "type": "string"
        },
        "places": {
          "type": "array",
          "items": {
            "type": "object"
          }
        },
        "signs": {
          "type": "array",
          "items": {
            "type": "object"
          }
        },
        "internals": {
          "type": "array",
          "items": {
            "type": "object"
          }
        },
        "directedInternals": {
          "type": "array",
          "items": {
            "type": "object"
          }
        },
        "compartmentNumbers": {
          "type": "array",
          "items": {
            "type": "object"
          }
        },
        "gridSize": {
          "type": "object",
          "required": [
            "x",
            "y"
          ],
          "properties": {
            "x": {
              "type": "integer"
            },
            "y": {
              "type": "integer"
            }
          }
        },
        "_links": {
          "type": "array",
          "items": {
            "type": "object"
          }
        }
      }
    },
    "CoachDeckLayout": {
      "type": "object",
      "required": [
        "name",
        "dimension",
        "id",
        "deckLevel"
      ],
      "properties": {
        "name": {
          "type": "string"
        },
        "dimension": {
          "type": "object",
          "required": [
            "width",
            "height"
          ],
          "properties": {
            "width": {
              "type": "integer"
            },
            "height": {
              "type": "integer"
            },
            "borderRadius": {
              "type": "object"
            }
          }
        },
        "lowFloorEntry": {
          "type": "boolean"
        },
        "id": {
          "type": "string"
        },
        "deckLevel": {
          "type": "string"
        },
        "placeGroups": {
          "type": "array",
          "items": {
            "type": "object"
          }
        },
        "graphicElements": {
          "type": "array",
          "items": {
            "type": "object"
          }
        },
        "serviceIcons": {
          "type": "array",
          "items": {
            "type": "object"
          }
        }
      }
    },
    "ReductionCardType": {
      "type": "object",
      "required": [
        "code",
        "issuer",
        "name"
      ],
      "properties": {
        "code": {
          "type": "string"
        },
        "shortCode": {
          "type": "string"
        },
        "issuer": {
          "type": "string"
        },
        "name": {
          "type": "object",
          "required": [
            "id",
            "text"
          ],
          "properties": {
            "id": {
              "type": "string"
            },
            "translations": {
              "type": "array"
            },
            "text": {
              "type": "string"
            },
            "shortText": {
              "type": "string"
            }
          }
        },
        "cardIdRequired": {
          "type": "boolean"
        },
        "includedCardTypes": {
          "type": "array",
          "items": {
            "type": "object"
          }
        },
        "serviceClassTypes": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "reductionsGranted": {
          "type": "array",
          "items": {
            "type": "object"
          }
        },
        "_links": {
          "type": "array",
          "items": {
            "type": "object"
          }
        }
      }
    },
    "ZoneDefinition": {
      "type": "object",
      "required": [
        "id",
        "carrier"
      ],
      "properties": {
        "id": {
          "type": "string"
        },
        "name": {
          "type": "string"
        },
        "carrier": {
          "type": "string"
        },
        "polygon": {
          "type": "object",
          "required": [
            "edges"
          ],
          "properties": {
            "edges": {
              "type": "array"
            }
          }
        },
        "nutsCodes": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "places": {
          "type": "array",
          "items": {
            "type": "object"
          }
        }
      }
    },
    "PromotionCode": {
      "type": "object",
      "required": [
        "code"
      ],
      "properties": {
        "code": {
          "type": "string"
        },
        "issuer": {
          "type": "string"
        }
      }
    },
    "PassengerCategory": {
      "type": "object",
      "required": [
        "title",
        "specification"
      ],
      "properties": {
        "base": {
          "type": "boolean"
        },
        "additional": {
          "type": "boolean"
        },
        "title": {
          "type": "object",
          "required": [
            "id",
            "text"
          ],
          "properties": {
            "id": {
              "type": "string"
            },
            "translations": {
              "type": "array"
            },
            "text": {
              "type": "string"
            },
            "shortText": {
              "type": "string"
            }
          }
        },
        "specification": {
          "type": "object",
          "required": [
            "externalRef",
            "type"
          ],
          "properties": {
            "externalRef": {
              "type": "string"
            },
            "dateOfBirth": {
              "type": "string"
            },
            "age": {
              "type": "integer"
            },
            "type": {
              "type": "string"
            },
            "prmNeeds": {
              "type": "array"
            },
            "cards": {
              "type": "array"
            },
            "gender": {
              "type": "string",
              "enum": [
                "MALE",
                "FEMALE",
                "X"
              ]
            },
            "residency": {
              "type": "string"
            }
          }
        }
      }
    },
    "ProductTagName": {
      "type": "object",
      "required": [
        "tag",
        "description"
      ],
      "properties": {
        "tag": {
          "type": "string"
        },
        "description": {
          "type": "object",
          "required": [
            "id",
            "text"
          ],
          "properties": {
            "id": {
              "type": "string"
            },
            "translations": {
              "type": "array"
            },
            "text": {
              "type": "string"
            },
            "shortText": {
              "type": "string"
            }
          }
        }
      }
    },
    "ProductTagGroup": {
      "type": "object",
      "required": [
        "code",
        "description"
      ],
      "properties": {
        "code": {
          "type": "string"
        },
        "description": {
          "type": "object",
          "required": [
            "id",
            "text"
          ],
          "properties": {
            "id": {
              "type": "string"
            },
            "translations": {
              "type": "array"
            },
            "text": {
              "type": "string"
            },
            "shortText": {
              "type": "string"
            }
          }
        },
        "productTags": {
          "type": "array",
          "items": {
            "type": "string"
          }
        }
      }
    },
    "Product": {
      "type": "object",
      "required": [
        "id",
        "code",
        "owner",
        "flexibility"
      ],
      "properties": {
        "id": {
          "type": "string"
        },
        "summary": {
          "type": "string"
        },
        "type": {
          "type": "string"
        },
        "code": {
          "type": "string"
        },
        "description": {
          "type": "string"
        },
        "owner": {
          "type": "string"
        },
        "conditions": {
          "type": "array",
          "items": {
            "type": "object"
          }
        },
        "flexibility": {
          "type": "string"
        },
        "serviceClass": {
          "type": "object",
          "required": [
            "type",
            "name"
          ],
          "properties": {
            "type": {
              "type": "string"
            },
            "name": {
              "type": "string"
            }
          }
        },
        "travelClass": {
          "type": "string"
        },
        "fulfillmentOptions": {
          "type": "array",
          "items": {
            "type": "object"
          }
        },
        "isTrainBound": {
          "type": "boolean"
        },
        "isReturnProduct": {
          "type": "boolean"
        },
        "serviceConstraintText": {
          "type": "string"
        },
        "carrierConstraintText": {
          "type": "string"
        },
        "descriptiveTexts": {
          "type": "array",
          "items": {
            "type": "object"
          }
        },
        "tariff": {
          "type": "string"
        },
        "combinationTags": {
          "type": "array",
          "items": {
            "type": "object"
          }
        },
        "productTags": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "_links": {
          "type": "array",
          "items": {
            "type": "object"
          }
        }
      }
    }
  },
  "3.7.0": {
    "ApiVersion": {
      "type": "object",
      "required": [
        "version"
      ],
      "properties": {
        "version": {
          "type": "string"
        },
        "sunset": {
          "type": "string"
        },
        "nextVersion": {
          "type": "object",
          "properties": {
            "version": {
              "type": "string"
            },
            "availableAt": {
              "type": "string"
            },
            "availableFrom": {
              "type": "string"
            }
          }
        }
      }
    },
    "CoachLayout": {
      "type": "object",
      "required": [
        "id",
        "gridSize"
      ],
      "properties": {
        "id": {
          "type": "string"
        },
        "summary": {
          "type": "string"
        },
        "places": {
          "type": "array",
          "items": {
            "type": "object"
          }
        },
        "signs": {
          "type": "array",
          "items": {
            "type": "object"
          }
        },
        "internals": {
          "type": "array",
          "items": {
            "type": "object"
          }
        },
        "directedInternals": {
          "type": "array",
          "items": {
            "type": "object"
          }
        },
        "compartmentNumbers": {
          "type": "array",
          "items": {
            "type": "object"
          }
        },
        "gridSize": {
          "type": "object",
          "required": [
            "x",
            "y"
          ],
          "properties": {
            "x": {
              "type": "integer"
            },
            "y": {
              "type": "integer"
            }
          }
        },
        "_links": {
          "type": "array",
          "items": {
            "type": "object"
          }
        }
      }
    },
    "CoachDeckLayout": {
      "type": "object",
      "required": [
        "name",
        "dimension",
        "id",
        "deckLevel"
      ],
      "properties": {
        "name": {
          "type": "string"
        },
        "dimension": {
          "type": "object",
          "required": [
            "width",
            "height"
          ],
          "properties": {
            "width": {
              "type": "integer"
            },
            "height": {
              "type": "integer"
            },
            "borderRadius": {
              "type": "object"
            }
          }
        },
        "lowFloorEntry": {
          "type": "boolean"
        },
        "id": {
          "type": "string"
        },
        "deckLevel": {
          "type": "string"
        },
        "placeGroups": {
          "type": "array",
          "items": {
            "type": "object"
          }
        },
        "graphicElements": {
          "type": "array",
          "items": {
            "type": "object"
          }
        },
        "serviceIcons": {
          "type": "array",
          "items": {
            "type": "object"
          }
        }
      }
    },
    "ReductionCardType": {
      "type": "object",
      "required": [
        "code",
        "issuer",
        "name"
      ],
      "properties": {
        "code": {
          "type": "string"
        },
        "shortCode": {
          "type": "string"
        },
        "issuer": {
          "type": "string"
        },
        "name": {
          "type": "object",
          "required": [
            "id",
            "text"
          ],
          "properties": {
            "id": {
              "type": "string"
            },
            "translations": {
              "type": "array"
            },
            "text": {
              "type": "string"
            },
            "shortText": {
              "type": "string"
            }
          }
        },
        "cardIdRequired": {
          "type": "boolean"
        },
        "includedCardTypes": {
          "type": "array",
          "items": {
            "type": "object"
          }
        },
        "serviceClassTypes": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "reductionsGranted": {
          "type": "array",
          "items": {
            "type": "object"
          }
        },
        "_links": {
          "type": "array",
          "items": {
            "type": "object"
          }
        }
      }
    },
    "ZoneDefinition": {
      "type": "object",
      "required": [
        "id",
        "carrier"
      ],
      "properties": {
        "id": {
          "type": "string"
        },
        "name": {
          "type": "string"
        },
        "carrier": {
          "type": "string"
        },
        "polygon": {
          "type": "object",
          "required": [
            "edges"
          ],
          "properties": {
            "edges": {
              "type": "array"
            }
          }
        },
        "nutsCodes": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "places": {
          "type": "array",
          "items": {
            "type": "object"
          }
        }
      }
    },
    "PromotionCode": {
      "type": "object",
      "required": [
        "code"
      ],
      "properties": {
        "code": {
          "type": "string"
        },
        "issuer": {
          "type": "string"
        }
      }
    },
    "PassengerCategory": {
      "type": "object",
      "required": [
        "title",
        "specification"
      ],
      "properties": {
        "base": {
          "type": "boolean"
        },
        "additional": {
          "type": "boolean"
        },
        "title": {
          "type": "object",
          "required": [
            "id",
            "text"
          ],
          "properties": {
            "id": {
              "type": "string"
            },
            "translations": {
              "type": "array"
            },
            "text": {
              "type": "string"
            },
            "shortText": {
              "type": "string"
            }
          }
        },
        "specification": {
          "type": "object",
          "required": [
            "externalRef",
            "type"
          ],
          "properties": {
            "externalRef": {
              "type": "string"
            },
            "dateOfBirth": {
              "type": "string"
            },
            "age": {
              "type": "integer"
            },
            "type": {
              "type": "string"
            },
            "prmNeeds": {
              "type": "array"
            },
            "cards": {
              "type": "array"
            },
            "gender": {
              "type": "string",
              "enum": [
                "MALE",
                "FEMALE",
                "X"
              ]
            },
            "residency": {
              "type": "string"
            },
            "transportable": {
              "type": "object"
            }
          }
        }
      }
    },
    "ProductTagName": {
      "type": "object",
      "required": [
        "tag",
        "description"
      ],
      "properties": {
        "tag": {
          "type": "string"
        },
        "description": {
          "type": "object",
          "required": [
            "id",
            "text"
          ],
          "properties": {
            "id": {
              "type": "string"
            },
            "translations": {
              "type": "array"
            },
            "text": {
              "type": "string"
            },
            "shortText": {
              "type": "string"
            }
          }
        }
      }
    },
    "ProductTagGroup": {
      "type": "object",
      "required": [
        "code",
        "description"
      ],
      "properties": {
        "code": {
          "type": "string"
        },
        "description": {
          "type": "object",
          "required": [
            "id",
            "text"
          ],
          "properties": {
            "id": {
              "type": "string"
            },
            "translations": {
              "type": "array"
            },
            "text": {
              "type": "string"
            },
            "shortText": {
              "type": "string"
            }
          }
        },
        "productTags": {
          "type": "array",
          "items": {
            "type": "string"
          }
        }
      }
    },
    "Product": {
      "type": "object",
      "required": [
        "id",
        "code",
        "owner",
        "flexibility"
      ],
      "properties": {
        "id": {
          "type": "string"
        },
        "summary": {
          "type": "string"
        },
        "type": {
          "type": "string"
        },
        "code": {
          "type": "string"
        },
        "description": {
          "type": "string"
        },
        "owner": {
          "type": "string"
        },
        "conditions": {
          "type": "array",
          "items": {
            "type": "object"
          }
        },
        "flexibility": {
          "type": "string"
        },
        "serviceClass": {
          "type": "object",
          "required": [
            "type",
            "name"
          ],
          "properties": {
            "type": {
              "type": "string"
            },
            "name": {
              "type": "string"
            }
          }
        },
        "travelClass": {
          "type": "string"
        },
        "fulfillmentOptions": {
          "type": "array",
          "items": {
            "type": "object"
          }
        },
        "isTrainBound": {
          "type": "boolean"
        },
        "isReturnProduct": {
          "type": "boolean"
        },
        "serviceConstraintText": {
          "type": "string"
        },
        "carrierConstraintText": {
          "type": "string"
        },
        "descriptiveTexts": {
          "type": "array",
          "items": {
            "type": "object"
          }
        },
        "tariff": {
          "type": "string"
        },
        "combinationTags": {
          "type": "array",
          "items": {
            "type": "object"
          }
        },
        "productTags": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "_links": {
          "type": "array",
          "items": {
            "type": "object"
          }
        }
      }
    }
  },
  "3.8.0": {
    "ApiVersion": {
      "type": "object",
      "required": [
        "version"
      ],
      "properties": {
        "version": {
          "type": "string"
        },
        "sunset": {
          "type": "string"
        },
        "nextVersion": {
          "type": "object",
          "properties": {
            "version": {
              "type": "string"
            },
            "availableAt": {
              "type": "string"
            },
            "availableFrom": {
              "type": "string"
            }
          }
        }
      }
    },
    "CoachLayout": {
      "type": "object",
      "required": [
        "id",
        "gridSize"
      ],
      "properties": {
        "id": {
          "type": "string"
        },
        "summary": {
          "type": "string"
        },
        "places": {
          "type": "array",
          "items": {
            "type": "object"
          }
        },
        "signs": {
          "type": "array",
          "items": {
            "type": "object"
          }
        },
        "internals": {
          "type": "array",
          "items": {
            "type": "object"
          }
        },
        "directedInternals": {
          "type": "array",
          "items": {
            "type": "object"
          }
        },
        "compartmentNumbers": {
          "type": "array",
          "items": {
            "type": "object"
          }
        },
        "gridSize": {
          "type": "object",
          "required": [
            "x",
            "y"
          ],
          "properties": {
            "x": {
              "type": "integer"
            },
            "y": {
              "type": "integer"
            }
          }
        },
        "_links": {
          "type": "array",
          "items": {
            "type": "object"
          }
        }
      }
    },
    "CoachDeckLayout": {
      "type": "object",
      "required": [
        "name",
        "dimension",
        "id",
        "deckLevel"
      ],
      "properties": {
        "name": {
          "type": "string"
        },
        "dimension": {
          "type": "object",
          "required": [
            "width",
            "height"
          ],
          "properties": {
            "width": {
              "type": "integer"
            },
            "height": {
              "type": "integer"
            },
            "borderRadius": {
              "type": "object"
            }
          }
        },
        "lowFloorEntry": {
          "type": "boolean"
        },
        "id": {
          "type": "string"
        },
        "deckLevel": {
          "type": "string"
        },
        "placeGroups": {
          "type": "array",
          "items": {
            "type": "object"
          }
        },
        "graphicElements": {
          "type": "array",
          "items": {
            "type": "object"
          }
        },
        "serviceIcons": {
          "type": "array",
          "items": {
            "type": "object"
          }
        }
      }
    },
    "ReductionCardType": {
      "type": "object",
      "required": [
        "code",
        "issuer",
        "name"
      ],
      "properties": {
        "code": {
          "type": "string"
        },
        "shortCode": {
          "type": "string"
        },
        "issuer": {
          "type": "string"
        },
        "name": {
          "type": "object",
          "required": [
            "id",
            "text"
          ],
          "properties": {
            "id": {
              "type": "string"
            },
            "translations": {
              "type": "array"
            },
            "text": {
              "type": "string"
            },
            "shortText": {
              "type": "string"
            }
          }
        },
        "cardIdRequired": {
          "type": "boolean"
        },
        "includedCardTypes": {
          "type": "array",
          "items": {
            "type": "object"
          }
        },
        "serviceClassTypes": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "reductionsGranted": {
          "type": "array",
          "items": {
            "type": "object"
          }
        },
        "_links": {
          "type": "array",
          "items": {
            "type": "object"
          }
        }
      }
    },
    "ZoneDefinition": {
      "type": "object",
      "required": [
        "id",
        "carrier"
      ],
      "properties": {
        "id": {
          "type": "string"
        },
        "name": {
          "type": "string"
        },
        "carrier": {
          "type": "string"
        },
        "polygon": {
          "type": "object",
          "required": [
            "edges"
          ],
          "properties": {
            "edges": {
              "type": "array"
            }
          }
        },
        "nutsCodes": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "places": {
          "type": "array",
          "items": {
            "type": "object"
          }
        }
      }
    },
    "PromotionCode": {
      "type": "object",
      "required": [
        "code"
      ],
      "properties": {
        "code": {
          "type": "string"
        },
        "issuer": {
          "type": "string"
        },
        "shortDescription": {
          "type": "object",
          "required": [
            "id",
            "text"
          ],
          "properties": {
            "id": {
              "type": "string"
            },
            "translations": {
              "type": "array"
            },
            "text": {
              "type": "string"
            },
            "shortText": {
              "type": "string"
            }
          }
        },
        "description": {
          "type": "object",
          "required": [
            "id",
            "text"
          ],
          "properties": {
            "id": {
              "type": "string"
            },
            "translations": {
              "type": "array"
            },
            "text": {
              "type": "string"
            },
            "shortText": {
              "type": "string"
            }
          }
        }
      }
    },
    "PassengerCategory": {
      "type": "object",
      "required": [
        "title",
        "specification"
      ],
      "properties": {
        "base": {
          "type": "boolean"
        },
        "additional": {
          "type": "boolean"
        },
        "title": {
          "type": "object",
          "required": [
            "id",
            "text"
          ],
          "properties": {
            "id": {
              "type": "string"
            },
            "translations": {
              "type": "array"
            },
            "text": {
              "type": "string"
            },
            "shortText": {
              "type": "string"
            }
          }
        },
        "specification": {
          "type": "object",
          "required": [
            "externalRef",
            "type"
          ],
          "properties": {
            "externalRef": {
              "type": "string"
            },
            "dateOfBirth": {
              "type": "string"
            },
            "age": {
              "type": "integer"
            },
            "type": {
              "type": "string"
            },
            "prmNeeds": {
              "type": "array"
            },
            "cards": {
              "type": "array"
            },
            "gender": {
              "type": "string",
              "enum": [
                "MALE",
                "FEMALE",
                "X"
              ]
            },
            "residency": {
              "type": "string"
            },
            "transportable": {
              "type": "object"
            }
          }
        }
      }
    },
    "ProductTagName": {
      "type": "object",
      "required": [
        "tag",
        "description"
      ],
      "properties": {
        "tag": {
          "type": "string"
        },
        "description": {
          "type": "object",
          "required": [
            "id",
            "text"
          ],
          "properties": {
            "id": {
              "type": "string"
            },
            "translations": {
              "type": "array"
            },
            "text": {
              "type": "string"
            },
            "shortText": {
              "type": "string"
            }
          }
        }
      }
    },
    "ProductTagGroup": {
      "type": "object",
      "required": [
        "code",
        "description"
      ],
      "properties": {
        "code": {
          "type": "string"
        },
        "description": {
          "type": "object",
          "required": [
            "id",
            "text"
          ],
          "properties": {
            "id": {
              "type": "string"
            },
            "translations": {
              "type": "array"
            },
            "text": {
              "type": "string"
            },
            "shortText": {
              "type": "string"
            }
          }
        },
        "productTags": {
          "type": "array",
          "items": {
            "type": "string"
          }
        }
      }
    },
    "Product": {
      "type": "object",
      "required": [
        "id",
        "code",
        "owner",
        "flexibility"
      ],
      "properties": {
        "id": {
          "type": "string"
        },
        "summary": {
          "type": "string"
        },
        "summaryTranslations": {
          "type": "array",
          "items": {
            "type": "object"
          }
        },
        "type": {
          "type": "string"
        },
        "code": {
          "type": "string"
        },
        "description": {
          "type": "string"
        },
        "descriptionTranslations": {
          "type": "array",
          "items": {
            "type": "object"
          }
        },
        "owner": {
          "type": "string"
        },
        "conditions": {
          "type": "array",
          "items": {
            "type": "object"
          }
        },
        "flexibility": {
          "type": "string"
        },
        "serviceClass": {
          "type": "object",
          "required": [
            "type",
            "name"
          ],
          "properties": {
            "type": {
              "type": "string"
            },
            "name": {
              "type": "string"
            }
          }
        },
        "travelClass": {
          "type": "string"
        },
        "fulfillmentOptions": {
          "type": "array",
          "items": {
            "type": "object"
          }
        },
        "isTrainBound": {
          "type": "boolean"
        },
        "isReturnProduct": {
          "type": "boolean"
        },
        "serviceConstraintText": {
          "type": "string"
        },
        "serviceConstraintTextTranslations": {
          "type": "array",
          "items": {
            "type": "object"
          }
        },
        "carrierConstraintText": {
          "type": "string"
        },
        "carrierConstraintTextTranslations": {
          "type": "array",
          "items": {
            "type": "object"
          }
        },
        "descriptiveTexts": {
          "type": "array",
          "items": {
            "type": "object"
          }
        },
        "tariff": {
          "type": "string"
        },
        "combinationTags": {
          "type": "array",
          "items": {
            "type": "object"
          }
        },
        "productTags": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "_links": {
          "type": "array",
          "items": {
            "type": "object"
          }
        }
      }
    }
  }
};

module.exports = { schemas };

try {
  Object.assign(globalThis, { osdmSchemas: schemas });
} catch (e) {
  console.log('[DEBUG] [library-bruno] globalThis exposure skipped: ' + (e && e.message));
}
