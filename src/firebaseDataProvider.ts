import * as firebase from "firebase";
import "firebase/firestore";

import {
  CREATE,
  DELETE,
  DELETE_MANY,
  GET_LIST,
  GET_MANY,
  GET_MANY_REFERENCE,
  GET_ONE,
  UPDATE,
  UPDATE_MANY
} from "react-admin";
import { Observable } from "rxjs";

export interface IResource {
  path: string;
  collection: firebase.firestore.CollectionReference;
  observable: Observable<{}>;
  list: Array<{}>;
}

// UTILS

function isEmptyObj(obj) {
  return JSON.stringify(obj) == "{}";
}

function log(description: string, obj: {}) {
  if (ISDEBUG) {
    console.log(description, obj);
  }
}

var ISDEBUG = false;

class FirebaseClient {
  private db: firebase.firestore.Firestore;
  private app: firebase.app.App;
  private resources: {
    [resourceName: string]: IResource;
  } = {};

  constructor(firebaseConfig: {}) {
    if (!firebase.apps.length) {
      this.app = firebase.initializeApp(firebaseConfig);
    } else {
      this.app = firebase.app();
    }
    this.db = this.app.firestore();
  }

  private parseFireStoreDocument(
    doc: firebase.firestore.QueryDocumentSnapshot
  ): {} {
    const data = doc.data();
    Object.keys(data).forEach(key => {
      const value = data[key];
      if (value && value.toDate && value.toDate instanceof Function) {
        data[key] = value.toDate().toISOString();
      }
    });
    // React Admin requires an id field on every document,
    // So we can just using the firestore document id
    return { id: doc.id, ...data };
  }

  public async initPath(path: string): Promise<void> {
    return new Promise(resolve => {
      const hasBeenInited = this.resources[path];
      if (hasBeenInited) {
        return resolve();
      }
      const collection = this.db.collection(path);
      const observable = this.getCollectionObservable(collection);
      observable.subscribe(
        (querySnapshot: firebase.firestore.QuerySnapshot) => {
          const newList = querySnapshot.docs.map(
            (doc: firebase.firestore.QueryDocumentSnapshot) =>
              this.parseFireStoreDocument(doc)
          );
          this.setList(newList, path);
          // The data has been set, so resolve the promise
          resolve();
        }
      );
      const list: Array<{}> = [];
      const r: IResource = {
        collection,
        list,
        observable,
        path
      };
      this.resources[path] = r;
      log("initPath", { path, r, "this.resources": this.resources });
    });
  }

  public async apiGetList(
    resourceName: string,
    params: IParamsGetList
  ): Promise<IResponseGetList> {
    const r = await this.tryGetResource(resourceName);
    const data = r.list;
    if (params.sort != null) {
      const { field, order } = params.sort;
      if (order === "ASC") {
        this.sortArray(data, field, "asc");
      } else {
        this.sortArray(data, field, "desc");
      }
    }
    log("apiGetList", { resourceName, resource: r, params });
    let filteredData = this.filterArray(data, params.filter);
    const pageStart = (params.pagination.page - 1) * params.pagination.perPage;
    const pageEnd = pageStart + params.pagination.perPage;
    const dataPage = filteredData.slice(pageStart, pageEnd);
    const total = r.list.length;
    return {
      data: dataPage,
      total
    };
  }

  public async apiGetOne(
    resourceName: string,
    params: IParamsGetOne
  ): Promise<IResponseGetOne> {
    const r = await this.tryGetResource(resourceName);
    log("apiGetOne", { resourceName, resource: r, params });
    const data = r.list.filter((val: { id: string }) => val.id === params.id);
    if (data.length < 1) {
      throw new Error(
        "react-admin-firebase: No id found matching: " + params.id
      );
    }
    return { data: data.pop() };
  }

  public async apiCreate(
    resourceName: string,
    params: IParamsCreate
  ): Promise<IResponseCreate> {
    const r = await this.tryGetResource(resourceName);
    log("apiCreate", { resourceName, resource: r, params });
    const doc = await r.collection.add({
      ...params.data,
      createdate: firebase.firestore.FieldValue.serverTimestamp(),
      lastupdate: firebase.firestore.FieldValue.serverTimestamp()
    });
    return {
      data: {
        ...params.data,
        id: doc.id
      }
    };
  }

  public async apiUpdate(
    resourceName: string,
    params: IParamsUpdate
  ): Promise<IResponseUpdate> {
    const id = params.id;
    delete params.data.id;
    const r = await this.tryGetResource(resourceName);
    log("apiUpdate", { resourceName, resource: r, params });
    r.collection.doc(id).update({
      ...params.data,
      lastupdate: firebase.firestore.FieldValue.serverTimestamp()
    });
    return {
      data: {
        ...params.data,
        id
      }
    };
  }

  public async apiUpdateMany(
    resourceName: string,
    params: IParamsUpdateMany
  ): Promise<IResponseUpdateMany> {
    delete params.data.id;
    const r = await this.tryGetResource(resourceName);
    log("apiUpdateMany", { resourceName, resource: r, params });
    const returnData = [];
    for (const id of params.ids) {
      r.collection.doc(id).update({
        ...params.data,
        lastupdate: firebase.firestore.FieldValue.serverTimestamp()
      });
      returnData.push({
        ...params.data,
        id
      });
    }
    return {
      data: returnData
    };
  }

  public async apiDelete(
    resourceName: string,
    params: IParamsDelete
  ): Promise<IResponseDelete> {
    const r = await this.tryGetResource(resourceName);
    log("apiDelete", { resourceName, resource: r, params });
    r.collection.doc(params.id).delete();
    return {
      data: params.previousData
    };
  }

  public async apiDeleteMany(
    resourceName: string,
    params: IParamsDeleteMany
  ): Promise<IResponseDeleteMany> {
    const r = await this.tryGetResource(resourceName);
    log("apiDeleteMany", { resourceName, resource: r, params });
    const returnData = [];
    const batch = this.db.batch();
    for (const id of params.ids) {
      batch.delete(r.collection.doc(id));
      returnData.push({ id });
    }
    batch.commit();
    return { data: returnData };
  }

  public async apiGetMany(
    resourceName: string,
    params: IParamsGetMany
  ): Promise<IResponseGetMany> {
    const r = await this.tryGetResource(resourceName);
    log("apiGetMany", { resourceName, resource: r, params });
    const ids = new Set(params.ids);
    const matches = r.list.filter(item => ids.has(item["id"]));
    return {
      data: matches
    };
  }

  public async apiGetManyReference(
    resourceName: string,
    params: IParamsGetManyReference
  ): Promise<IResponseGetManyReference> {
    const r = await this.tryGetResource(resourceName);
    log("apiGetManyReference", { resourceName, resource: r, params });
    const data = r.list;
    const targetField = params.target;
    const targetValue = params.id;
    const matches = data.filter(val => val[targetField] === targetValue);
    if (params.sort != null) {
      const { field, order } = params.sort;
      if (order === "ASC") {
        this.sortArray(data, field, "asc");
      } else {
        this.sortArray(data, field, "desc");
      }
    }
    const pageStart = (params.pagination.page - 1) * params.pagination.perPage;
    const pageEnd = pageStart + params.pagination.perPage;
    const dataPage = matches.slice(pageStart, pageEnd);
    const total = matches.length;
    return { data: dataPage, total };
  }

  public GetResource(resourceName: string): IResource {
    return this.tryGetResource(resourceName);
  }

  private sortArray(data: Array<{}>, field: string, dir: "asc" | "desc"): void {
    data.sort((a: {}, b: {}) => {
      const aValue = a[field] ? a[field].toString().toLowerCase() : "";
      const bValue = b[field] ? b[field].toString().toLowerCase() : "";
      if (aValue > bValue) {
        return dir === "asc" ? -1 : 1;
      }
      if (aValue < bValue) {
        return dir === "asc" ? 1 : -1;
      }
      return 0;
    });
  }

  private filterArray(
    data: Array<{}>,
    filterFields: { [field: string]: string }
  ): Array<{}> {
    if (isEmptyObj(filterFields)) {
      return data;
    }
    const fieldNames = Object.keys(filterFields);
    return data.filter(item =>
      fieldNames.reduce((previousMatched, fieldName) => {
        const fieldSearchText = filterFields[fieldName].toLowerCase();
        const dataFieldValue = item[fieldName];
        if (dataFieldValue == null) {
          return false;
        }
        const currentIsMatched = dataFieldValue
          .toLowerCase()
          .includes(fieldSearchText);
        return previousMatched || currentIsMatched;
      }, false)
    );
  }

  private async setList(
    newList: Array<{}>,
    resourceName: string
  ): Promise<void> {
    const resource = await this.tryGetResource(resourceName);
    resource.list = newList;
  }

  private tryGetResource(resourceName: string): IResource {
    const resource: IResource = this.resources[resourceName];
    if (!resource) {
      throw new Error(
        `react-admin-firebase: Cant find resource: "${resourceName}"`
      );
    }
    return resource;
  }

  private getCollectionObservable(
    collection: firebase.firestore.CollectionReference
  ): Observable<firebase.firestore.QuerySnapshot> {
    const observable: Observable<
      firebase.firestore.QuerySnapshot
    > = Observable.create((observer: any) => collection.onSnapshot(observer));
    // LOGGING
    return observable;
  }
}

export let fb: FirebaseClient;

export default function FirebaseProvider(config: {}) {
  if (!config) {
    throw new Error(
      "Please pass the Firebase config.json object to the FirebaseDataProvider"
    );
  }
  ISDEBUG = config["debug"];
  fb = new FirebaseClient(config);
  async function providerApi(
    type: string,
    resourceName: string,
    params: any
  ): Promise<any> {
    await fb.initPath(resourceName);
    switch (type) {
      case GET_MANY:
        return fb.apiGetMany(resourceName, params);
      case GET_MANY_REFERENCE:
        return fb.apiGetManyReference(resourceName, params);
      case GET_LIST:
        return fb.apiGetList(resourceName, params);
      case GET_ONE:
        return fb.apiGetOne(resourceName, params);
      case CREATE:
        return fb.apiCreate(resourceName, params);
      case UPDATE:
        return fb.apiUpdate(resourceName, params);
      case UPDATE_MANY:
        return fb.apiUpdateMany(resourceName, params);
      case DELETE:
        return fb.apiDelete(resourceName, params);
      case DELETE_MANY:
        return fb.apiDeleteMany(resourceName, params);
      default:
        return {};
    }
  }
  return providerApi;
}
