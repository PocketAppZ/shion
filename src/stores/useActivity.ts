import type { Event } from '@tauri-apps/api/event'
import { listen } from '@tauri-apps/api/event'

import type * as backend from '@interfaces/backend'
import type { Activity } from '@interfaces/index'

export const useActivity = defineStore('activity', () => {
  const monitor = useMonitor()

  const activityList = ref<Activity[]>([])

  let timeout: number
  let task: (immediate: boolean) => Promise<void> = async () => {}
  let lastActivity: backend.Activity | null = null

  async function init() {
    activityList.value = await selectActivity()
  }

  init()

  listen('program-activity', async (event: Event<backend.Activity>) => {
    const { payload } = event
    const exist = lastActivity && isCaseInsensitivePathEqual(lastActivity.path, payload.path) && lastActivity.title == payload.title
    if (exist)
      return
    const vaildProgram = monitor.whiteList.find(i => isCaseInsensitivePathEqual(i.path, payload.path))
    if (!vaildProgram) {
      task(true)
      return
    }
    const isAnotherProgram = lastActivity && !isCaseInsensitivePathEqual(lastActivity.path, payload.path)
    if (isAnotherProgram)
      await task(true)

    lastActivity = payload
    const activity: Omit<Activity, 'id'> = {
      programId: vaildProgram.id,
      active: true,
      time: payload.time,
      title: payload.title,
    }
    const { lastInsertId } = await createActivity(activity)
    activityList.value.push({
      ...activity,
      id: lastInsertId,
    })

    task = async (immediate: boolean) => {
      clearTimeout(timeout)
      const fn = () => {
        createActivity({
          ...activity,
          time: Date.now(),
          active: false,
        })
        task = async () => { }
        lastActivity = null
      }
      if (immediate)
        fn()
      else
        timeout = setTimeout(fn, 1000 * 60)
    }
    task(false)
  })

  const activate = useThrottleFn(() => task(false), 1000)

  listen('program-activity-activate', activate)

  return {
    activityList,
  }
})