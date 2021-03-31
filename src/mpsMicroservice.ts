/*********************************************************************
* Copyright (c) Intel Corporation 2019
* SPDX-License-Identifier: Apache-2.0
**********************************************************************/

import { configType, certificatesType } from './models/Config'
import { WebServer } from './server/webserver'
import { MPSServer } from './server/mpsserver'
import { logger as log } from './utils/logger'
import { IDbProvider } from './models/IDbProvider'
import { getDistributedKV } from './utils/IDistributedKV'
import { MpsProxy } from './server/proxies/MpsProxy'
import { CiraConnectionFactory } from './CiraConnectionFactory'
import { CiraChannelFactory } from './CiraChannelFactory'
import session from 'express-session'
import redis from 'redis'
import connectRedis from 'connect-redis'
import { MPSMode } from './utils/constants'

export class MPSMicroservice {
  mpsserver: MPSServer
  webserver: WebServer
  config: configType
  certs: certificatesType
  debugLevel: number = 1
  mpsComputerList = {}
  db: IDbProvider
  ciraConnectionFactory: CiraConnectionFactory
  ciraChannelFactory: CiraChannelFactory
  sess: any

  constructor (config: configType, db: IDbProvider, certs: certificatesType) {
    try {
      this.config = config
      this.debugLevel = config.debug_level
      this.db = db
      this.certs = certs
    } catch (e) {
      log.error(`Exception in MPS Microservice: ${e}`)
    }
  }

  start (): void {
    if (this.config.startup_mode === MPSMode.Standalone) {
      // Session Configuration
      this.sess = {
        // Strongly recommended to change this key for Production thru ENV variable MPS_SESSION_ENCRYPTION_KEY
        secret: this.config.session_encryption_key || '<YourStrongRandomizedKey123!>',
        name: 'SessionSupport',
        resave: true,
        saveUninitialized: true,
        cookie: { secure: false } // by default false. use true for prod like below.
      }
      this.webserver = new WebServer(this)
      this.mpsserver = new MPSServer(this)
      this.ciraConnectionFactory = new CiraConnectionFactory(async (hostGuid) => this.mpsserver.ciraConnections[hostGuid])
      this.ciraChannelFactory = new CiraChannelFactory((socket, port) => this.mpsserver.SetupCiraChannel(socket, port))
    } else if (this.config.startup_mode === MPSMode.WEB) { // Running in distributed mode
      if (this.config.redis_enable) {
        log.silly('Redis enabled')
        // Session handling with Redis - in scale mode
        const redisClient = redis.createClient({ port: this.config.redis_port, host: this.config.redis_host, password: this.config.redis_password }) // "redis" container
        const RedisStore = connectRedis(session)
        log.silly('connect to Redis')
        redisClient.on('error', (err) => {
          console.log('Redis error: ', err)
        })

        // Session Configuration
        this.sess = {
          // Strongly recommended to change this key for Production thru ENV variable MPS_SESSION_ENCRYPTION_KEY
          secret: this.config.session_encryption_key || '<YourStrongRandomizedKey123!>',
          name: 'SessionSupport',
          resave: true,
          saveUninitialized: true,
          cookie: { secure: false }, // by default false. use true for prod like below.
          store: new RedisStore({ host: this.config.redis_host, port: this.config.redis_port, client: redisClient, ttl: 86400 })
        }
      } else {
        log.silly('Redis disabled')
        // Session Configuration
        this.sess = {
          // Strongly recommended to change this key for Production thru ENV variable MPS_SESSION_ENCRYPTION_KEY
          secret: this.config.session_encryption_key || '<YourStrongRandomizedKey123!>',
          name: 'SessionSupport',
          resave: true,
          saveUninitialized: true,
          cookie: { secure: false } // by default false. use true for prod like below.
        }
      }

      this.webserver = new WebServer(this)
      getDistributedKV(this).addEventWatch()
      this.ciraConnectionFactory = new CiraConnectionFactory(async (hostGuid) => {
        const mpsProxy = await MpsProxy.getSocketForGuid(hostGuid, this)
        mpsProxy.nodeid = hostGuid
        return mpsProxy
      })
      this.ciraChannelFactory = new CiraChannelFactory((mpsProxy, port) => mpsProxy.SetupCiraChannel(port, mpsProxy.nodeid)) // here socket passed would be Mps Proxy
    } else if (this.config.startup_mode === MPSMode.MPS) { // Running in distributed mode
      this.mpsserver = new MPSServer(this) // MPS only takes in connections from web or devices. so no need to have a connection or channel factory
    } else {
      log.error('Unknown startup mode. Exiting.')
      process.exit(1)
    }
  }

  CIRAConnected (guid: string): void {
    log.info(`CIRA connection established for ${guid}`)

    if (this.config.startup_mode === MPSMode.MPS) {
      // update DistributedKV with key as device UUID
      // and value as Server IP.f
      getDistributedKV(this).updateKV(guid).then((v) => log.debug(v)).catch((reason) => log.error(reason))
    } else if (this.config.startup_mode === MPSMode.WEB) {
      MpsProxy.getSocketForGuid(guid, this).catch(err => {
        log.error(`failed to get socket for guid: ${guid}, result: ${err}`)
      })
    }

    if (this.webserver) {
      this.webserver.notifyUsers({ host: guid, event: 'node_connection', status: 'connected' })
    }
  }

  CIRADisconnected (guid: string): void {
    log.info(`Main:CIRA connection closed for ${guid}`)

    if (this.config.startup_mode === MPSMode.MPS) {
      // delete the KV pair in DistributedKV
      getDistributedKV(this).deleteKV(guid).then((v) => log.debug(v)).catch((reason) => log.error(reason))
    } else if (this.config.startup_mode === MPSMode.WEB) {
      if (MpsProxy.proxies[guid]) {
        log.silly('Cleaning up MpsProxy.proxies entry.')
        delete MpsProxy.proxies[guid]
      }
    }

    if (guid && this.mpsComputerList[guid]) {
      log.silly(`delete mpsComputerList[${guid}]`)
      delete this.mpsComputerList[guid]
      if (this.webserver) {
        this.webserver.notifyUsers({
          host: guid,
          event: 'node_connection',
          status: 'disconnected'
        })
      }
    }
  }
}
