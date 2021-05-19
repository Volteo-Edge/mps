/*********************************************************************
* Copyright (c) Intel Corporation 2019
* SPDX-License-Identifier: Apache-2.0
* Description: Handler to execute a power action on amt device
**********************************************************************/

import { Response, Request } from 'express'
import { logger as log } from '../../utils/logger'
import { amtPort, MPSMode } from '../../utils/constants'
import { ErrorResponse } from '../../utils/amtHelper'
import { validationResult } from 'express-validator'

export async function powerAction(req: Request, res: Response): Promise<void> {
  try {

    //Initialize variables and check for immediate errors
    const payload = req.body
    const guid = req.params.guid
    const errors = validationResult(req)
    if (!errors.isEmpty()) {
      res.status(400).json({ errors: errors.array() }).end()
      return
    }

    //Find cira connection to work with or return a 404 error
    const ciraconn = await req.mpsService.ciraConnectionFactory.getConnection(guid)
    if (ciraconn && ciraconn.readyState === 'open') {

      const cred = await req.mpsService.db.getAmtPassword(guid)
      const amtstack = req.amtFactory.getAmtStack(guid, amtPort, cred[0], cred[1], 0)

      //---------------------------- getBootData ------------------------------
      let amtPowerBootCapabilities

      //Handler func will be given to the amtStack to perform the power action
      const handler = (stack, name, response, status): void => {

        //Error check
        if (status !== 200) {
          log.error(`Power Action failed during PUT AMT_BootSettingData for guid : ${guid}`)
          res.status(status).json(ErrorResponse(status, 'Power Action failed during GET AMT_BootSettingData.')).end()
          return
        }

        //Prepare boot setting data
        const bootSettingData = response.Body
        if (payload.action !== 999) {
          bootSettingData.BIOSPause = false
          bootSettingData.BIOSSetup = payload.action > 99 && payload.action < 104
          bootSettingData.BootMediaIndex = 0
          bootSettingData.ConfigurationDataReset = false
          bootSettingData.FirmwareVerbosity = 0
          bootSettingData.ForcedProgressEvents = false
          bootSettingData.IDERBootDevice = payload.action === 202 || payload.action === 203 ? 1 : 0 // 0 = Boot on Floppy, 1 = Boot on IDER
          bootSettingData.LockKeyboard = false
          bootSettingData.LockPowerButton = false
          bootSettingData.LockResetButton = false
          bootSettingData.LockSleepButton = false
          bootSettingData.ReflashBIOS = false
          bootSettingData.UseIDER = payload.action > 199 && payload.action < 300
          bootSettingData.UseSOL = payload.useSOL
          bootSettingData.UseSafeMode = false
          bootSettingData.UserPasswordBypass = false

          if (bootSettingData.SecureErase) {
            bootSettingData.SecureErase = payload.action === 104 && amtPowerBootCapabilities.SecureErase === true
          }
        }

        //-------------------------- putBootData -------------------------
        const putCallback = (stack, name, response, status, tag): void => {
          if (status !== 200) {
            log.error(
              `Power Action failed during PUT AMT_BootSettingData for guid : ${guid}`
            )
            res.status(status).json(ErrorResponse(status, 'Power Action failed during GET AMT_BootSettingData.')).end()
            return
          }
          //----------------------- setBootConfRole -----------------------

          let idxD24ForceBootDevice
          const setCallback = (stack, name, response, status): void => {
            if (status !== 200) {
              log.error(`Power Action failed during SetBootConfigRole for guid : ${guid}`
              )
              res.status(status).json(ErrorResponse(status, 'Power Action failed during SetBootConfigRole.')).end()
              return
            }

            let bootSource = null
            if (payload.action === 999) {
              if (idxD24ForceBootDevice.value > 0) {
                bootSource = ['Force CD/DVD Boot', 'Force PXE Boot', 'Force Hard-drive Boot', 'Force Diagnostic Boot'][idxD24ForceBootDevice.value - 1]
              }
            } else {
              if (payload.action === 300 || payload.action === 301) {
                bootSource = 'Force Diagnostic Boot'
              }
              if (payload.action === 400 || payload.action === 401) {
                bootSource = 'Force PXE Boot'
              }
            }

            //Add xml context around bootSource
            if (bootSource != null) {
              bootSource =
                `<Address xmlns="http://schemas.xmlsoap.org/ws/2004/08/addressing">http://schemas.xmlsoap.org/ws/2004/08/addressing</Address>
          <ReferenceParameters xmlns="http://schemas.xmlsoap.org/ws/2004/08/addressing">
            <ResourceURI xmlns="http://schemas.dmtf.org/wbem/wsman/1/wsman.xsd">http://schemas.dmtf.org/wbem/wscim/1/cim-schema/2/CIM_BootSourceSetting</ResourceURI>
            <SelectorSet xmlns="http://schemas.dmtf.org/wbem/wsman/1/wsman.xsd">
              <Selector Name="InstanceID">Intel(r) AMT: ${bootSource}</Selector>
            </SelectorSet>
          </ReferenceParameters>`
            }

            //--------------------------- changeBootOrder ---------------------------
            amtstack.CIM_BootConfigSetting_ChangeBootOrder(
              bootSource,
              (stack, name, response, status) => {
                if (status !== 200) {
                  log.error(
                    `Power Action failed during ChangeBootOrder for guid : ${guid}`
                  )
                  res.status(status).json(ErrorResponse(status, 'Power Action failed during ChangeBootOrder.')).end()
                  return
                }

                //Change action to either power up or reset
                switch (payload.action) {
                  case 100:
                  case 201:
                  case 203:
                  case 300:
                  case 401:
                    payload.action = 2 //Power up
                    break
                  case 101:
                  case 104: 
                  case 200:
                  case 202:
                  case 301:
                  case 400:
                  case 11:
                    payload.action = 10 //Reset
                    break
                  default:
                    break
                }

                if (payload.action < 999) {
                  //------------ powerStateChange ---------------
                  amtstack.RequestPowerStateChange(
                    payload.action,
                    (stack, name, response, status) => {
                      if (req.mpsService.config.startup_mode === MPSMode.Standalone) {
                        stack.wsman.comm.socket.sendchannelclose()
                      }
                      if (status === 200) {
                        // log.info(`Power state change request successful for guid : ${uuid}`);
                        res.status(200).json(response).end()
                      } else {
                        log.error(`Power state change request failed for guid : ${guid}`)
                        res.status(status).json(ErrorResponse(status, 'PowerStateChange request failed.')).end()
                      }
                    }
                  )
                  // --------------- End of PowerState Change ------------
                } else {
                  // TODO: Advanced options
                }
              }
            )
            // ----------------------- End Change Boot Order -------------------------
          }

          amtstack.SetBootConfigRole(1, setCallback, 0, 1)
          //--------------------- End setBootConfRole ---------------------
        }
        amtstack.Put('AMT_BootSettingData', bootSettingData, putCallback, bootSettingData, 1)
        //---------------------- End of PutBootData ----------------------
      }

      amtstack.Get('AMT_BootSettingData', handler, 0, 1)
      // ----------------------- End of GetBootData ---------------------------
    } else {
      //cira connection not found
      res.status(404).json(ErrorResponse(404, `guid : ${guid}`, 'device')).end()
    }
  } catch (error) {
    log.error(`Exception in Power action : ${error}`)
    res.status(500).json(ErrorResponse(500, 'Request failed during AMT Power action execution.')).end()
  }
}
