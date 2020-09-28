const fs = require('fs').promises
const path = require('path')
const walk = require('walkdir')
const yaml = require('yaml')
const prettier = require('prettier')
const { compile: schema2tsCompile } = require('json-schema-to-typescript')
const Ajv = require('ajv')

const pprint = obj =>
  console.log(require('util').inspect(obj, false, null, true))

// camelCase / kebab-case / snake_case to PascalCase
const toPascalCase = name =>
  name.replace(
    /([a-zA-Z])([a-zA-Z0-9]*)[-_]?/g,
    (match, ch1, rest) => ch1.toUpperCase() + rest
  )
// PascalCase / kebab-case / snake_case to camelCase
const toCamelCase = name =>
  toPascalCase(name).replace(/^./, ch => ch.toLowerCase())

const strEnumToTs = strEnum => strEnum.map(e => `'${e}'`).join(' | ')

const makeSchemaModifier = (modifier, inPlace) => {
  inPlace = inPlace ?? false
  const doModify = schema => {
    schema = modifier(schema)
    if (schema.type === 'object' && schema.properties) {
      if (!inPlace) {
        schema.properties = { ...schema.properties }
      }
      for (const key of Object.keys(schema.properties)) {
        schema.properties[key] = doModify(schema.properties[key])
      }
    }
    if (schema.type === 'array') {
      if (schema.items instanceof Array) {
        schema.items = schema.items.map(doModify)
      } else {
        schema.items = doModify(schema.items)
      }
    }
    return schema
  }
  return doModify
}

const disallowAdditonalProperties = makeSchemaModifier(schema => {
  schema = { ...schema }
  if (schema.type === 'object') {
    if (!('additionalProperties' in schema)) {
      schema.additionalProperties = false
    }
  }
  return schema
})

const omit = (object, property) => {
  if (property instanceof Array) {
    let ret = object
    for (const prop of property) {
      ret = omit(object, prop)
    }
    return ret
  }

  const ret = { ...object }
  delete ret[property]
  return ret
}

const normalizeOneOf = makeSchemaModifier(schema => {
  if (schema.oneOf) {
    const oneOf = schema.oneOf.map(subschema => ({
      ...omit(schema, 'oneOf'),
      ...subschema,
    }))
    return { oneOf }
  } else {
    return schema
  }
})

const trim = (parts, ...args) => {
  let templated = ''
  let i = 0
  for (; i < parts.length - 1; i++) {
    templated += parts[i] + args[i]
  }
  templated += parts[i]
  return templated.replace(/^[ \n]*\n(?=[^\n])|(?<=[^\n]\n)[\n ]*$/g, '')
}

;(async () => {
  const responseSchema = yaml.parse(
    await fs.readFile(path.resolve(__dirname, 'response.schema.yml'), 'utf8')
  )
  const permsSchema = yaml.parse(
    await fs.readFile(path.resolve(__dirname, 'perms.schema.yml'), 'utf8')
  )
  const routeSchema = yaml.parse(
    await fs.readFile(path.resolve(__dirname, 'route.schema.yml'), 'utf8')
  )

  const ajv = new Ajv({
    useDefaults: true,
    allErrors: true,
  })

  const responseValidator = ajv.compile(responseSchema)

  const routeMethodEnum = routeSchema.properties.method.enum

  const prettierOpts = await prettier.resolveConfig()
  const compileOpts = {
    bannerComment: '',
    style: prettierOpts,
  }

  const makePrettierTag = parser => (code, ...args) => {
    if (code instanceof Array) {
      // Tagged template literal
      let templated = ''
      let i = 0
      for (; i < code.length - 1; i++) {
        templated += code[i] + args[i]
      }
      templated += code[i]
      code = templated
    }
    return prettier.format(code, {
      ...prettierOpts,
      parser,
    })
  }

  const ts = makePrettierTag('typescript')
  const js = makePrettierTag('babel')

  const routeMethodStrEnum = strEnumToTs(routeMethodEnum)

  let responseGlobalTypes = ''

  const responseKindTypeName = 'ResponseKind'
  const responseKindType = ts`
    export type ${responseKindTypeName}<PayloadType = unknown> = {
      status: number
      readonly __response_payload?: PayloadType
    } & (
      | {
          message: string
          data?: object | false
        }
      | {
          rawJson: object
        }
      | {
          rawContentType: string
        }
    )
  `
  responseGlobalTypes += '\n' + responseKindType
  const getRespPayloadTypeTypeName = 'GetResponsePayloadType'
  const getRespPayloadTypeType = ts`
    export type ${getRespPayloadTypeTypeName}<
      Kind extends ${responseKindTypeName}<unknown>
    > = Kind extends ${responseKindTypeName}<infer PayloadType>
      ? PayloadType extends undefined
        ? never
        : PayloadType
      : never
  `
  responseGlobalTypes += '\n' + getRespPayloadTypeType
  responseGlobalTypes = ts(responseGlobalTypes)
  console.log(responseGlobalTypes)

  const compile = (schema, name, opts) =>
    schema2tsCompile(
      schema,
      name,
      opts ? { ...compileOpts, ...opts } : compileOpts
    )

  const sourceRoot = path.resolve(__dirname, '../src')

  // RESPONSES

  const responseFiles = await walk.async(path.resolve(sourceRoot, 'responses'))

  const responseKindRegex = /([a-z][a-zA-Z]*)\.ya?ml/

  const loadResponseEntryFromFile = async file => {
    const responseKindMatch = responseKindRegex.exec(file)
    if (responseKindMatch == null) {
      return
    }

    const responseKind = responseKindMatch[1]

    const responseObj = yaml.parse(await fs.readFile(file, 'utf8'))

    if (!responseValidator(responseObj)) {
      console.error(`${responseKind} not valid:`)
      console.error(responseValidator.errors)
      console.error(responseObj)
      throw responseValidator.errors
    }

    const responseTypeIdent = toPascalCase(responseKind)

    let tsDef = ''
    if ('rawJson' in responseObj) {
      tsDef += await compile(responseObj.rawJson, responseTypeIdent)
    }
    if ('data' in responseObj) {
      tsDef += await compile(responseObj.data, responseTypeIdent + 'Data')
    }
    if ('message' in responseObj) {
      tsDef += '\n'
      tsDef += trim`
        export interface ${responseTypeIdent} {
          kind: '${responseKind}'
          message: string
      `
      if ('data' in responseObj) {
        tsDef += trim`
          data: ${responseTypeIdent}Data
        `
      }
      tsDef += trim`
        }
      `
    }

    tsDef = ts(tsDef)

    const entry = {
      object: responseObj,
      tsDef,
    }

    if (!entry.tsDef) {
      delete entry.tsDef
    }

    return [responseKind, entry]
  }

  const responses = new Map(
    (await Promise.all(responseFiles.map(loadResponseEntryFromFile))).filter(
      e => e
    )
  )

  pprint(responses)

  // PERMISSIONS

  const permsConfig = await (async () => {
    const foundFiles = (
      await Promise.all(
        ['yaml', 'yml']
          .map(ext => path.resolve(sourceRoot, `perms.${ext}`))
          .map(async fpath => {
            try {
              await fs.stat(fpath)
              return fpath
            } catch {
              return false
            }
          })
      )
    ).filter(f => f)
    if (foundFiles.length > 1) {
      const err = 'Conflicting perms.y(a)ml found!'
      console.error(err)
      throw new Error(err)
    } else if (foundFiles.length === 0) {
      const err = 'No perms.y(a)ml found!'
      console.error(err)
      throw new Error(err)
    }
    return yaml.parse(await fs.readFile(foundFiles[0], 'utf8'))
  })()

  permsSchema.additionalProperties.oneOf[1].items.enum = Object.keys(
    permsConfig
  ).sort()
  const permsValidator = ajv.compile(permsSchema)
  if (!permsValidator(permsConfig)) {
    console.error('perms not valid:')
    console.error(permsValidator.errors)
    console.error(permsConfig)
    throw permsValidator.errors
  }
  const permsMap = new Map()
  ;(() => {
    const toConcretize = Object.keys(permsConfig)
    while (toConcretize.length > 0) {
      const currLen = toConcretize.length
      for (let i = 0; i < currLen && toConcretize.length > 0; ++i) {
        const curr = toConcretize.shift()
        const val = permsConfig[curr]
        if (val instanceof Array) {
          let mask = 0
          let successful = true
          for (const key of val) {
            const v = permsMap.get(key)
            if (v !== undefined) {
              mask |= v
            } else {
              successful = false
              break
            }
          }
          if (successful) {
            permsMap.set(curr, mask)
          } else {
            toConcretize.push(curr)
          }
        } else {
          permsMap.set(curr, 1 << val)
        }
      }
      if (toConcretize.length === currLen) {
        console.error('perms not valid:')
        console.error('Reference loop detected:')
        console.error(toConcretize)
        throw new Error('Reference loop detected')
      }
    }
  })()
  pprint(permsMap)

  let permsGlobalTypes = ''
  permsGlobalTypes += trim`
    export enum Permissions {
  `
  for (const [name, val] of permsMap.entries()) {
    permsGlobalTypes += trim`
      ${name} = ${val},
    `
  }
  permsGlobalTypes += trim`
    }

    export default Permissions
  `
  permsGlobalTypes = ts(permsGlobalTypes)
  console.log(permsGlobalTypes)

  // ROUTES

  routeSchema.properties.responses.items.enum = [...responses.keys()].sort()
  routeSchema.properties.perms.items.enum = [...permsMap.keys()].sort()
  const routeValidator = ajv.compile(routeSchema)

  let routeGlobalTypes = ts`
    import { ResponsePayloads } from './responses'
  `

  const routeTypeName = 'Route'
  const _routeTypeResponseSymbol = '$$RESPONSE_TYPE$$'
  const _routeSchemaForTypeCompilation = JSON.parse(
    JSON.stringify(disallowAdditonalProperties(routeSchema))
  )
  _routeSchemaForTypeCompilation.properties.responses.tsType = _routeTypeResponseSymbol
  const _routeSchemaResponseKindsEnum = strEnumToTs(
    routeSchema.properties.responses.items.enum
  )
  const routeType = ts(
    (
      await compile(_routeSchemaForTypeCompilation, routeTypeName, {
        ignoreMinAndMaxItems: true,
      })
    )
      .replace(
        routeTypeName,
        `${routeTypeName}<
          ResponseKinds extends ${_routeSchemaResponseKindsEnum} = ${_routeSchemaResponseKindsEnum},
          BodyType = unknown,
          QSType = unknown,
          ParamsType = unknown,
        >`
      )
      .replace(_routeTypeResponseSymbol, `[ResponseKinds, ...ResponseKinds[]]`)
      .replace(/\}\s*$/, '') +
      '\n' +
      trim`
        readonly __body_type?: BodyType
        readonly __qs_type?: QSType
        readonly __params_type?: ParamsType
      }
      `
  )
  routeGlobalTypes += '\n' + routeType

  const getRouteBodyTypeTypeName = 'GetRouteBodyType'
  const getRouteBodyTypeType = ts`
    export type ${getRouteBodyTypeTypeName}<
      R extends ${routeTypeName}<unknown, unknown, unknown, unknown>
    > = R extends ${routeTypeName}<unknown, infer BodyType, unknown, unknown>
      ? BodyType extends undefined
        ? never
        : BodyType
      : never
  `
  routeGlobalTypes += '\n' + getRouteBodyTypeType

  const getRouteQSTypeTypeName = 'GetRouteQSType'
  const getRouteQSTypeType = ts`
    export type ${getRouteQSTypeTypeName}<
      R extends ${routeTypeName}<unknown, unknown, unknown, unknown>
    > = R extends ${routeTypeName}<unknown, unknown, infer QSType, unknown>
      ? QSType extends undefined
        ? never
        : QSType
      : never
  `
  routeGlobalTypes += '\n' + getRouteQSTypeType

  const getRouteParamsTypeTypeName = 'GetRouteParamsType'
  const getRouteParamsTypeType = ts`
    export type ${getRouteParamsTypeTypeName}<
      R extends ${routeTypeName}<unknown, unknown, unknown, unknown>
    > = R extends ${routeTypeName}<unknown, unknown, unknown, infer ParamsType>
      ? ParamsType extends undefined
        ? never
        : ParamsType
      : never
  `
  routeGlobalTypes += '\n' + getRouteParamsTypeType

  const getRouteResponseTypeTypeName = 'GetRouteResponseType'
  const getRouteResponseTypeType = ts`
    export type ${getRouteResponseTypeTypeName}<
      R extends ${routeTypeName}<unknown, unknown, unknown, unknown>
    > = R extends ${routeTypeName}<infer ResponseKinds, unknown, unknown, unknown>
      ? ResponsePayloads[ResponseKinds]
      : never
  `
  routeGlobalTypes += '\n' + getRouteResponseTypeType

  routeGlobalTypes = ts(routeGlobalTypes)
  console.log(routeGlobalTypes)

  const yamlExtRegex = /\.ya?ml$/
  const routeRoot = path.resolve(sourceRoot, 'routes')
  const routeFiles = (await walk.async(routeRoot)).filter(file =>
    yamlExtRegex.test(file)
  )

  const loadRouteFromFile = async file => {
    const routeObj = yaml.parse(await fs.readFile(file, 'utf8'))

    const routeIdent = toCamelCase(
      path
        .relative(routeRoot, file)
        .replace(/\//g, '-')
        .replace(yamlExtRegex, '')
    )

    if (!routeValidator(routeObj)) {
      console.error(`${file} not valid:`)
      console.error(routeValidator.errors)
      console.error(routeObj)
      throw routeValidator.errors
    }

    const routeTypeIdentPrefix = toPascalCase(routeIdent) + 'Request'

    let tsDef = ''
    let routeTypeBodyType = 'never'
    let routeTypeQSType = 'never'
    let routeTypeParamsType = 'never'
    if (routeObj.schema) {
      if (routeObj.schema.body) {
        routeTypeBodyType = routeTypeIdentPrefix + 'Body'
        tsDef +=
          '\n' +
          (await compile(
            normalizeOneOf(routeObj.schema.body),
            routeTypeBodyType
          ))
      }
      if (routeObj.schema.querystring) {
        routeTypeQSType = routeTypeIdentPrefix + 'QS'
        tsDef +=
          '\n' +
          (await compile(
            normalizeOneOf(routeObj.schema.querystring),
            routeTypeQSType
          ))
      }
      if (routeObj.schema.params) {
        routeTypeParamsType = routeTypeIdentPrefix + 'Params'
        tsDef +=
          '\n' +
          (await compile(
            normalizeOneOf(routeObj.schema.params),
            routeTypeParamsType
          ))
      }
    }

    tsDef = ts(tsDef)

    const typeDef = ts`
      type T = ${routeTypeName}<
        ${strEnumToTs(routeObj.responses)},
        ${routeTypeBodyType},
        ${routeTypeQSType},
        ${routeTypeParamsType},
      >
    `.replace(/\s*type T =\s*/, '')

    const routeObjConcrete = { ...routeObj }
    if ('perms' in routeObjConcrete) {
      routeObjConcrete.perms = 0
      for (const role of routeObj.perms) {
        routeObjConcrete.perms |= permsMap.get(role)
      }
    }

    const entry = {
      object: routeObjConcrete,
      ident: routeIdent,
      typeDef,
      tsDef,
    }

    return entry
  }

  const routes = await Promise.all(routeFiles.map(loadRouteFromFile))

  pprint(routes)
})()
