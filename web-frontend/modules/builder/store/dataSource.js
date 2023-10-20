import DataSourceService from '@baserow/modules/builder/services/dataSource'
import PublishedBuilderService from '@baserow/modules/builder/services/publishedBuilder'
import { ELEMENT_EVENTS } from '../enums'

const state = {}

const updateContext = {
  updateTimeout: null,
  promiseResolve: null,
  lastUpdatedValues: null,
  valuesToUpdate: {},
}

const mutations = {
  ADD_ITEM(state, { page, dataSource, beforeId = null }) {
    if (beforeId === null) {
      page.dataSources.push(dataSource)
    } else {
      const insertionIndex = page.dataSources.findIndex(
        (e) => e.id === beforeId
      )
      page.dataSources.splice(insertionIndex, 0, dataSource)
    }
  },
  UPDATE_ITEM(state, { page, dataSource: dataSourceToUpdate, values }) {
    const index = page.dataSources.findIndex(
      (dataSource) => dataSource.id === dataSourceToUpdate.id
    )
    page.dataSources.splice(index, 1, {
      ...page.dataSources[index],
      ...values,
    })
  },
  FULL_UPDATE_ITEM(state, { page, dataSource: dataSourceToUpdate, values }) {
    const index = page.dataSources.findIndex(
      (dataSource) => dataSource.id === dataSourceToUpdate.id
    )
    page.dataSources.splice(index, 1, {
      ...values,
    })
  },
  DELETE_ITEM(state, { page, dataSourceId }) {
    const index = page.dataSources.findIndex(
      (dataSource) => dataSource.id === dataSourceId
    )
    if (index > -1) {
      page.dataSources.splice(index, 1)
    }
  },
  MOVE_ITEM(state, { page, index, oldIndex }) {
    page.dataSources.splice(index, 0, page.dataSources.splice(oldIndex, 1)[0])
  },
  CLEAR_ITEMS(state, { page }) {
    page.dataSources = []
  },
  SET_LOADING(state, { page, value }) {
    page._.dataSourceLoading = value
  },
}

const actions = {
  forceCreate({ commit }, { page, dataSource, beforeId = null }) {
    commit('ADD_ITEM', { page, dataSource, beforeId })
  },
  forceUpdate({ commit }, { page, dataSource, values }) {
    commit('UPDATE_ITEM', { page, dataSource, values })
  },
  forceDelete({ commit, dispatch }, { page, dataSourceId }) {
    // Remove related content first
    dispatch(
      'dataSourceContent/clearDataSourceContent',
      { page, dataSourceId },
      { root: true }
    )
    //
    dispatch(
      'element/emitElementEvent',
      { event: ELEMENT_EVENTS.DATA_SOURCE_REMOVED, page, dataSourceId },
      { root: true }
    )
    commit('DELETE_ITEM', { page, dataSourceId })
  },
  forceMove({ commit, getters }, { page, dataSourceId, beforeDataSourceId }) {
    const currentOrder = getters
      .getPageDataSources(page)
      .map((dataSource) => dataSource.id)

    const oldIndex = currentOrder.findIndex((id) => id === dataSourceId)
    const index = beforeDataSourceId
      ? currentOrder.findIndex((id) => id === beforeDataSourceId)
      : getters.getPageDataSources(page).length

    // If the dataSource is before the beforeDataSource we must decrease the target index by
    // one to compensate the removed dataSource.
    if (oldIndex < index) {
      commit('MOVE_ITEM', { page, index: index - 1, oldIndex })
    } else {
      commit('MOVE_ITEM', { page, index, oldIndex })
    }
  },
  async create({ commit, dispatch }, { page, values, beforeId }) {
    commit('SET_LOADING', { page, value: true })
    const { data: dataSource } = await DataSourceService(this.$client).create(
      page.id,
      values,
      beforeId
    )

    await dispatch('forceCreate', { page, dataSource, beforeId })
    commit('SET_LOADING', { page, value: false })
  },
  async update({ commit, dispatch }, { page, dataSourceId, values }) {
    const dataSourcesOfPage = getters.getPageDataSources(page)
    const dataSource = dataSourcesOfPage.find(
      (dataSource) => dataSource.id === dataSourceId
    )
    const oldValues = {}
    const newValues = {}
    Object.keys(values).forEach((name) => {
      if (Object.prototype.hasOwnProperty.call(dataSource, name)) {
        oldValues[name] = dataSource[name]
        newValues[name] = values[name]
      }
    })

    await dispatch('forceUpdate', { page, dataSource, values: newValues })

    commit('SET_LOADING', { page, value: true })
    try {
      await DataSourceService(this.$client).update(dataSource.id, values)
    } catch (error) {
      await dispatch('forceUpdate', { page, dataSource, values: oldValues })
      throw error
    }
    commit('SET_LOADING', { page, value: false })
  },

  async debouncedUpdate(
    { dispatch, getters, commit },
    { page, dataSourceId, values }
  ) {
    const dataSourcesOfPage = getters.getPageDataSources(page)
    const dataSource = dataSourcesOfPage.find(
      (dataSource) => dataSource.id === dataSourceId
    )
    const oldValues = {}
    Object.keys(values).forEach((name) => {
      if (Object.prototype.hasOwnProperty.call(dataSource, name)) {
        oldValues[name] = dataSource[name]
        // Accumulate the changed values to send all the ongoing changes with the
        // final request
        updateContext.valuesToUpdate[name] = values[name]
      }
    })

    // If we have a dataSource type, fetch it from the service type registry
    // then call the registry's `beforeUpdate` hook to optionally manipulate
    // the values prior to performing an update.
    if (dataSource.type !== null) {
      const dataSourceType = this.$registry.get('service', dataSource.type)
      updateContext.valuesToUpdate = dataSourceType.beforeUpdate(
        updateContext.valuesToUpdate,
        oldValues
      )
    }

    await dispatch('forceUpdate', {
      page,
      dataSource,
      values: updateContext.valuesToUpdate,
    })

    return new Promise((resolve, reject) => {
      const fire = async () => {
        const toUpdate = updateContext.valuesToUpdate
        updateContext.valuesToUpdate = {}
        commit('SET_LOADING', { page, value: true })
        try {
          const { data } = await DataSourceService(this.$client).update(
            dataSource.id,
            toUpdate
          )
          await commit('FULL_UPDATE_ITEM', { page, dataSource, values: data })
          updateContext.lastUpdatedValues = null
          resolve()
        } catch (error) {
          // Revert to old values on error
          await dispatch('forceUpdate', {
            page,
            dataSource,
            values: updateContext.lastUpdatedValues,
          })
          updateContext.lastUpdatedValues = null
          reject(error)
        }
        commit('SET_LOADING', { page, value: false })
      }

      if (updateContext.promiseResolve) {
        updateContext.promiseResolve()
        updateContext.promiseResolve = null
      }

      clearTimeout(updateContext.updateTimeout)

      if (!updateContext.lastUpdatedValues) {
        updateContext.lastUpdatedValues = oldValues
      }

      updateContext.updateTimeout = setTimeout(fire, 500)
      updateContext.promiseResolve = resolve
    })
  },
  async delete({ commit, dispatch, getters }, { page, dataSourceId }) {
    const dataSourcesOfPage = getters.getPageDataSources(page)
    const dataSourceIndex = dataSourcesOfPage.findIndex(
      (dataSource) => dataSource.id === dataSourceId
    )
    const dataSourceToDelete = dataSourcesOfPage[dataSourceIndex]
    const beforeId =
      dataSourceIndex !== dataSourcesOfPage.length - 1
        ? dataSourcesOfPage[dataSourceIndex + 1].id
        : null

    await dispatch('forceDelete', { page, dataSourceId })

    commit('SET_LOADING', { page, value: true })
    try {
      await DataSourceService(this.$client).delete(dataSourceId)
    } catch (error) {
      await dispatch('forceCreate', {
        page,
        dataSource: dataSourceToDelete,
        beforeId,
      })
      throw error
    }
    commit('SET_LOADING', { page, value: false })
  },
  async fetch({ dispatch, commit }, { page }) {
    commit('SET_LOADING', { page, value: true })
    dispatch(
      'dataSourceContent/clearDataSourceContents',
      { page },
      { root: true }
    )
    const { data: dataSources } = await DataSourceService(
      this.$client
    ).fetchAll(page.id)

    commit('CLEAR_ITEMS', { page })
    await Promise.all(
      dataSources.map((dataSource) =>
        dispatch('forceCreate', { page, dataSource })
      )
    )
    commit('SET_LOADING', { page, value: false })

    return dataSources
  },
  async fetchPublished({ dispatch, commit }, { page }) {
    commit('SET_LOADING', { page, value: true })
    dispatch(
      'dataSourceContent/clearDataSourceContents',
      { page },
      { root: true }
    )

    const { data: dataSources } = await PublishedBuilderService(
      this.$client
    ).fetchDataSources(page.id)

    commit('CLEAR_ITEMS', { page })
    await Promise.all(
      dataSources.map((dataSource) =>
        dispatch('forceCreate', { page, dataSource })
      )
    )
    commit('SET_LOADING', { page, value: false })

    return dataSources
  },
  async move({ dispatch }, { page, dataSourceId, beforeDataSourceId }) {
    await dispatch('forceMove', { page, dataSourceId, beforeDataSourceId })

    try {
      await DataSourceService(this.$client).move(
        dataSourceId,
        beforeDataSourceId
      )
    } catch (error) {
      await dispatch('forceMove', {
        page,
        dataSourceId: beforeDataSourceId,
        beforeDataSourceId: dataSourceId,
      })
      throw error
    }
  },
  async duplicate({ commit, getters, dispatch }, { page, dataSourceId }) {
    const dataSourcesOfPage = getters.getPageDataSources(page)
    const dataSource = dataSourcesOfPage.find((e) => e.id === dataSourceId)
    commit('SET_LOADING', { page, value: true })
    await dispatch('create', {
      page,
      dataSourceType: dataSource.type,
      beforeId: dataSource.id,
    })
    commit('SET_LOADING', { page, value: false })
  },
}

const getters = {
  getPageDataSources: (state) => (page) => {
    return page.dataSources
  },
  getPageDataSourceById: (state) => (page, id) => {
    return page.dataSources.find((dataSource) => dataSource.id === id)
  },
  getLoading: (state) => (page) => {
    return page._.dataSourceLoading
  },
}

export default {
  namespaced: true,
  state,
  getters,
  actions,
  mutations,
}
