import QlogConnectionGroup from '@/data/ConnectionGroup';


import * as qlog01 from '@quictools/qlog-schema';
import * as qlogPreSpec from '@quictools/qlog-schema/draft-16/QLog';
import { QUtil } from '@quictools/qlog-schema/util';
import QlogConnection from '@/data/Connection';
import { IQlogEventParser, IQlogRawEvent, TimeTrackingMethod } from '@/data/QlogEventParser';


export class QlogLoader {

    public static fromJSON(json:any) : QlogConnectionGroup | undefined {

        if ( json && json.qlog_version ){
            const version = json.qlog_version;
            if ( version === "0.1" ){
                return QlogLoader.fromPreSpec(json);
            }
            else if ( version === "draft-00" ){
                return QlogLoader.fromDraft00(json);
            }
            else if ( version === "draft-01" ){
                return QlogLoader.fromDraft01(json);
            }
            else if ( version === "draft-02-wip" ){
                return QlogLoader.fromDraft02(json);
            }
            else {
                console.error("QlogLoader: Unknown qlog version! Only draft-00, draft-01 and draft-02-wip are supported!", version, json);
                
                return undefined;
            }
        }
        else {
            console.error("QlogLoader: qlog files MUST have a qlog_version field in their top-level object!", json);

            return undefined;
        }

    }

    protected static fromDraft02(json:any) : QlogConnectionGroup {

        const fileContents:qlog01.IQLog = json as qlog01.IQLog;

        console.log("QlogLoader:fromDraft02-wip : ", fileContents, fileContents.traces);

        const group = new QlogConnectionGroup();
        group.version = fileContents.qlog_version;
        group.title = fileContents.title || "";
        group.description = fileContents.description || "";

        for ( let jsonconnection of fileContents.traces ){

            // a single trace can contain multiple component "traces" if group_id is used and we need to split them out first
            const qlogconnections:Array<QlogConnection> = new Array<QlogConnection>();

            if ( (jsonconnection as qlog01.ITraceError).error_description !== undefined ) {
                jsonconnection = jsonconnection as qlog01.ITraceError;

                const conn = new QlogConnection(group);
                conn.title = "ERROR";
                conn.description = jsonconnection.uri + " : " + jsonconnection.error_description;
                continue;
            }

            jsonconnection = jsonconnection as qlog01.ITrace;

            const groupIDIndex:number = jsonconnection.event_fields.indexOf("group_id");
            if ( jsonconnection.event_fields && groupIDIndex >= 0 ) {
                const groupLUT:Map<string, QlogConnection> = new Map<string, QlogConnection>();

                for ( const event of jsonconnection.events ) {

                    // allow an empy last element to get around trailing comma restrictions in JSON
                    if ( event.length === 0 || Object.keys(event).length === 0 ) {
                        continue;
                    }

                    let groupID = event[ groupIDIndex ];
                    if ( typeof groupID !== "string" ) {
                        groupID = JSON.stringify(groupID);
                    }

                    let conn = groupLUT.get(groupID as string);
                    if ( !conn ){
                        conn = new QlogConnection(group);
                        conn.title = "Group " + groupID + " : ";
                        groupLUT.set( groupID as string, conn );

                        qlogconnections.push( conn );
                    }

                    conn.getEvents().push( event );
                }
            }
            else {
                // just one component trace, easy mode
                const conn = new QlogConnection(group);
                qlogconnections.push( conn );
                conn.setEvents( jsonconnection.events as any );


                // allow an empy last element to get around trailing comma restrictions in JSON
                const lastEvent = jsonconnection.events[ jsonconnection.events.length - 1 ];
                if ( lastEvent.length === 0 || Object.keys(lastEvent).length === 0 ) {
                    conn.getEvents().splice( jsonconnection.events.length - 1, 1 );
                }
            }

            // component traces share most properties of the overlapping parent trace (e.g., vantage point etc.)
            for ( const connection of qlogconnections ){

                connection.title += jsonconnection.title ? jsonconnection.title : "";
                connection.description += jsonconnection.description ? jsonconnection.description : "";
                
                connection.vantagePoint = jsonconnection.vantage_point || {} as qlog01.IVantagePoint;

                if ( !connection.vantagePoint.type ){
                    connection.vantagePoint.type = qlog01.VantagePointType.unknown;
                    connection.vantagePoint.flow = qlog01.VantagePointType.unknown;
                    connection.vantagePoint.name = "No VantagePoint set";
                }

                connection.eventFieldNames = jsonconnection.event_fields;
                connection.commonFields = jsonconnection.common_fields!;
                connection.configuration = jsonconnection.configuration || {};

                connection.setEventParser( new EventFieldsParser() );

                // TODO: remove! Slows down normal traces!
                let misOrdered = false;
                let minimumTime = -1;
                for ( const evt of connection.getEvents() ){
                    const parsedEvt = connection.parseEvent(evt);
                    
                    if ( parsedEvt.absoluteTime >= minimumTime ){
                        minimumTime = parsedEvt.absoluteTime;
                    }
                    else {
                        misOrdered = true;
                        console.error("QlogLoader:draft02 : timestamps were not in the correct order!", parsedEvt.absoluteTime, " < ", minimumTime, parsedEvt);
                        break;
                    }
                }

                if ( misOrdered ){
                    connection.getEvents().sort( (a, b) => { return connection.parseEvent(a).absoluteTime - connection.parseEvent(b).absoluteTime });
                    console.error("QlogLoader:draft02 : manually sorted trace on timestamps!", connection.getEvents());
                    connection.setEventParser( new EventFieldsParser() ); // because startTime etc. could have changes because of the re-ordering

                    alert("Loaded trace was not absolutely ordered on event timestamps. We performed a sort() in qvis, but this slows things down and isn't guaranteed to be stable if the timestamps aren't unique! The qlog spec requires absolutely ordered timestamps. See the console for more details.");
                }
            }
        }

        return group;
    }

    protected static fromDraft01(json:any) : QlogConnectionGroup {

        const fileContents:qlog01.IQLog = json as qlog01.IQLog;

        console.log("QlogLoader:fromDraft01 : ", fileContents, fileContents.traces);

        const group = new QlogConnectionGroup();
        group.version = fileContents.qlog_version;
        group.title = fileContents.title || "";
        group.description = fileContents.description || "";

        for ( let jsonconnection of fileContents.traces ){

            // a single trace can contain multiple component "traces" if group_id is used and we need to split them out first
            const qlogconnections:Array<QlogConnection> = new Array<QlogConnection>();

            if ( (jsonconnection as qlog01.ITraceError).error_description !== undefined ) {
                jsonconnection = jsonconnection as qlog01.ITraceError;

                const conn = new QlogConnection(group);
                conn.title = "ERROR";
                conn.description = jsonconnection.uri + " : " + jsonconnection.error_description;
                continue;
            }

            jsonconnection = jsonconnection as qlog01.ITrace;

            const groupIDIndex:number = jsonconnection.event_fields.indexOf("group_id");
            if ( jsonconnection.event_fields && groupIDIndex >= 0 ) {
                const groupLUT:Map<string, QlogConnection> = new Map<string, QlogConnection>();

                for ( const event of jsonconnection.events ) {

                    // allow an empy last element to get around trailing comma restrictions in JSON
                    if ( event.length === 0 || Object.keys(event).length === 0 ) {
                        continue;
                    }

                    let groupID = event[ groupIDIndex ];
                    if ( typeof groupID !== "string" ) {
                        groupID = JSON.stringify(groupID);
                    }

                    let conn = groupLUT.get(groupID as string);
                    if ( !conn ){
                        conn = new QlogConnection(group);
                        conn.title = "Group " + groupID + " : ";
                        groupLUT.set( groupID as string, conn );

                        qlogconnections.push( conn );
                    }

                    conn.getEvents().push( event );
                }
            }
            else {
                // just one component trace, easy mode
                const conn = new QlogConnection(group);
                qlogconnections.push( conn );
                conn.setEvents( jsonconnection.events as any );


                // allow an empy last element to get around trailing comma restrictions in JSON
                const lastEvent = jsonconnection.events[ jsonconnection.events.length - 1 ];
                if ( lastEvent.length === 0 || Object.keys(lastEvent).length === 0 ) {
                    conn.getEvents().splice( jsonconnection.events.length - 1, 1 );
                }
            }

            // component traces share most properties of the overlapping parent trace (e.g., vantage point etc.)
            for ( const connection of qlogconnections ){

                connection.title += jsonconnection.title ? jsonconnection.title : "";
                connection.description += jsonconnection.description ? jsonconnection.description : "";
                
                connection.vantagePoint = jsonconnection.vantage_point || {} as qlog01.IVantagePoint;

                if ( !connection.vantagePoint.type ){
                    connection.vantagePoint.type = qlog01.VantagePointType.unknown;
                    connection.vantagePoint.flow = qlog01.VantagePointType.unknown;
                    connection.vantagePoint.name = "No VantagePoint set";
                }

                connection.eventFieldNames = jsonconnection.event_fields;
                connection.commonFields = jsonconnection.common_fields!;
                connection.configuration = jsonconnection.configuration || {};

                connection.setEventParser( new EventFieldsParser() );


                let needsUpgrade = false;
                for ( const evt of connection.getEvents() ){
                    const parsedEvt = connection.parseEvent(evt);
                    const data = parsedEvt.data;
                    
                    if ( data && data.type ){
                        needsUpgrade = true;
                        data.packet_type = data.type.toLowerCase(); // older version of draft-01 had .type instead of .packet_type // FIXME: remove!
                    }
                    else if ( data && data.packet_type ){
                        data.type = data.packet_type.toLowerCase(); // older version of draft-01 had .type instead of .packet_type // FIXME: remove!
                    }
                }

                // we had a version in between draft-00 and draft-01 that was also using the "draft-01" version...
                // it looks a lot like draft-01, but still requires some changes
                // we use some heuristics to see if it's the in-between version (semi-01) or not
                if ( !needsUpgrade ) {
                    for ( const evt of connection.getEvents() ){
                        const parsedEvt = connection.parseEvent(evt);

                        if ( parsedEvt.name === "metric_update" || // old name for metrics_updated, indicates semi-01
                             parsedEvt.name === "connection_new" || 
                             parsedEvt.name === "connection_close" || 
                             parsedEvt.name === "alpn_update" ||
                             parsedEvt.name === "version_update" ||
                             parsedEvt.name === "connection_id_update" ){
                            needsUpgrade = true;
                            break;
                        }
                        else if ( parsedEvt.name === "parameters_set" ){ // there was no parameters_set in semi-01
                            needsUpgrade = false;
                            break;
                        }
                        else if ( parsedEvt.data.id !== undefined ) { // in -01, each id field is push_id or stream_id
                            needsUpgrade = true;
                            break;
                        }
                        else if ( parsedEvt.data.frames !== undefined ) {
                            for ( const frame of parsedEvt.data.frames ){
                                if ( frame.id ){ // in -01, each id field is push_id or stream_id
                                    needsUpgrade = true;
                                    break;
                                }
                            }
                            if ( needsUpgrade ){
                                break;
                            }
                        }
                        else if ( parsedEvt.data.packet_type === "onertt" ) {
                            needsUpgrade = true;
                            break;
                        }
                        else if ( parsedEvt.data.packet_type === "zerortt" ) {
                            needsUpgrade = true;
                            break;
                        }
                    }
                }

                if ( needsUpgrade ){
                    QlogLoader.fixPreviousInto01( connection );
                }

                 // TODO: remove! Slows down normal traces!
                let misOrdered = false;
                let minimumTime = -1;
                for ( const evt of connection.getEvents() ){
                    const parsedEvt = connection.parseEvent(evt);
                     
                    if ( parsedEvt.absoluteTime >= minimumTime ){
                        minimumTime = parsedEvt.absoluteTime;
                    }
                    else {
                        misOrdered = true;
                        console.error("QlogLoader:draft01 : timestamps were not in the correct order!", parsedEvt.absoluteTime, " < ", minimumTime, parsedEvt);
                        break;
                    }
                 }
 
                if ( misOrdered ){
                    connection.getEvents().sort( (a, b) => { return connection.parseEvent(a).absoluteTime - connection.parseEvent(b).absoluteTime });
                    console.error("QlogLoader:draft01 : manually sorted trace on timestamps!", connection.getEvents());
                    connection.setEventParser( new EventFieldsParser() ); // because startTime etc. could have changes because of the re-ordering
 
                    alert("Loaded trace was not absolutely ordered on event timestamps. We performed a sort() in qvis, but this slows things down and isn't guaranteed to be stable if the timestamps aren't unique! The qlog spec requires absolutely ordered timestamps. See the console for more details.");
                 }
            }
        }

        return group;
    }

    protected static fixPreviousInto01( connection:QlogConnection ){
        console.log("QlogLoader:fixPreviousInto01 : ", connection);

        for ( const evt of connection.getEvents() ){
            const parsedEvt = connection.parseEvent(evt);

            if ( parsedEvt.name === "connection_new" ) {
                parsedEvt.name = qlog01.ConnectivityEventType.connection_started;
            }
            else if ( parsedEvt.name === "connection_id_update" ) {
                parsedEvt.name = qlog01.ConnectivityEventType.connection_id_updated;
            }
            else if ( parsedEvt.name === "key_update" ) {
                parsedEvt.name = qlog01.SecurityEventType.key_updated;
            }
            else if ( parsedEvt.name === "key_retire" ) {
                parsedEvt.name = qlog01.SecurityEventType.key_retired;
            }
            else if ( parsedEvt.name === "stream_state_update" ) {
                parsedEvt.name = qlog01.TransportEventType.stream_state_updated;
            }
            else if ( parsedEvt.name === "cc_state_update" ) {
                parsedEvt.name = qlog01.RecoveryEventType.congestion_state_updated;
            }
            else if ( parsedEvt.name === "loss_alarm_set" ) {
                parsedEvt.name = qlog01.RecoveryEventType.loss_timer_set;
            }
            else if ( parsedEvt.name === "loss_alarm_fired" ) {
                parsedEvt.name = qlog01.RecoveryEventType.loss_timer_triggered;
            }
            else if ( parsedEvt.name === "connection_close" ) {
                parsedEvt.name = qlog01.ConnectivityEventType.connection_state_updated;
                parsedEvt.data.new = qlog01.ConnectionState.closed;
                if ( parsedEvt.data.src_id ){
                    parsedEvt.data.src_id = "removed when converting to draft-01";
                }
            }
            else if ( parsedEvt.name === "cipher_update" ){
                parsedEvt.name = qlog01.TransportEventType.parameters_set;
                parsedEvt.data.tls_cipher = parsedEvt.data.new || "was set";
                if ( parsedEvt.data.new ) {
                    parsedEvt.data.new = "removed when converting to draft-01";
                }
            } 
            else if ( parsedEvt.name === "version_update" ){
                parsedEvt.name = qlog01.TransportEventType.parameters_set;
                parsedEvt.data.quic_version = parsedEvt.data.new || "was set";
                if ( parsedEvt.data.new ) {
                    parsedEvt.data.new = "removed when converting to draft-01";
                }
            } 
            else if ( parsedEvt.name === "alpn_update" ){
                parsedEvt.name = qlog01.TransportEventType.parameters_set;
                parsedEvt.data.alpn = parsedEvt.data.new || "was set";
                if ( parsedEvt.data.new ) {
                    parsedEvt.data.new = "removed when converting to draft-01";
                }
            }
            // semi-01
            else if ( parsedEvt.name === "metric_update" ){ // old name for metrics_updated, indicates semi-01
                parsedEvt.name = qlog01.RecoveryEventType.metrics_updated;
            }
            else if ( parsedEvt.name === "datagram_sent" ){
                parsedEvt.name = qlog01.TransportEventType.datagrams_sent;
            }
            else if ( parsedEvt.name === "datagram_received" ){
                parsedEvt.name = qlog01.TransportEventType.datagrams_received;
            }
            else if ( parsedEvt.name === "spin_bit_update" ){
                parsedEvt.name = qlog01.ConnectivityEventType.spin_bit_updated;
            }
            else if ( parsedEvt.data.frames !== undefined ){
                for ( const frame of parsedEvt.data.frames ){
                    if ( frame.id !== undefined ){
                        if ( frame.frame_type.indexOf("push") >= 0  ){
                            frame.push_id = frame.id;
                        }
                        else {
                            frame.stream_id = frame.id;
                        }
                    }
                    if ( frame.fields !== undefined ){
                        frame.headers = frame.fields;
                    }
                }
            }
            else if ( parsedEvt.name === "transport_parameters_update" ){
                parsedEvt.name = qlog01.TransportEventType.parameters_set;

                for ( const param of parsedEvt.data.parameters ) {
                    parsedEvt.data[ param.name ] = param.value;
                }

                parsedEvt.data.parameters = [];
            }
            
            if ( parsedEvt.data.packet_type === "onertt" ) {
                parsedEvt.data.packet_type = qlog01.PacketType.onertt;
            }
            else if ( parsedEvt.data.packet_type === "zerortt" ) {
                parsedEvt.data.packet_type = qlog01.PacketType.zerortt;
            }
        }
    }

    protected static fromDraft00(json:any) : QlogConnectionGroup {

        const fileContents:any = json; // we don't have TypeScript schema definitions for qlog00

        console.log("QlogLoader:fromDraft00 : ", fileContents, fileContents.traces);

        // TODO: rename QlogConnectionGroup because it's confusing with the group_id (they are NOT the same concepts!)
        const group = new QlogConnectionGroup();
        group.version = fileContents.qlog_version;
        group.title = fileContents.title || "";
        group.description = fileContents.description || "";

        for ( const jsonconnection of fileContents.traces ){

            // a single trace can contain multiple component "traces" if group_id is used and we need to split them out first
            const qlogconnections:Array<QlogConnection> = new Array<QlogConnection>();

            const groupIDIndex:number = jsonconnection.event_fields.indexOf("group_id");
            if ( jsonconnection.event_fields && groupIDIndex >= 0 ) {
                const groupLUT:Map<string, QlogConnection> = new Map<string, QlogConnection>();

                for ( const event of jsonconnection.events ) {
                    // allow an empy last element to get around trailing comma restrictions in JSON
                    if ( event.length === 0 || Object.keys(event).length === 0 ) {
                        continue;
                    }

                    let groupID = event[ groupIDIndex ];
                    if ( typeof groupID !== "string" ) {
                        groupID = JSON.stringify(groupID);
                    }

                    let conn = groupLUT.get(groupID);
                    if ( !conn ){
                        conn = new QlogConnection(group);
                        conn.title = "Group " + groupID + " : ";
                        groupLUT.set( groupID, conn );

                        qlogconnections.push( conn );
                    }

                    conn.getEvents().push( event );
                }
            }
            else {
                // just one component trace, easy mode
                const conn = new QlogConnection(group);
                qlogconnections.push( conn );
                conn.setEvents( jsonconnection.events as any );

                // allow an empy last element to get around trailing comma restrictions in JSON
                const lastEvent = jsonconnection.events[ jsonconnection.events.length - 1 ];
                if ( lastEvent.length === 0 || Object.keys(lastEvent).length === 0 ) {
                    conn.getEvents().splice( jsonconnection.events.length - 1, 1 );
                }
            }

            // component traces share most properties of the overlapping parent trace (e.g., vantage point etc.)
            for ( const connection of qlogconnections ){

                connection.title += jsonconnection.title ? jsonconnection.title : "";
                connection.description += jsonconnection.description ? jsonconnection.description : "";

                connection.vantagePoint = {} as qlog01.IVantagePoint;
                if ( jsonconnection.vantage_point ){
                    connection.vantagePoint.name = jsonconnection.vantage_point.name || "";

                    if ( jsonconnection.vantage_point.type === "SERVER" || jsonconnection.vantage_point.type === "server" ){
                        connection.vantagePoint.type = qlog01.VantagePointType.server;
                    }
                    else if ( jsonconnection.vantage_point.type === "CLIENT" || jsonconnection.vantage_point.type === "client" ){
                        connection.vantagePoint.type = qlog01.VantagePointType.client;
                    }
                    else if ( jsonconnection.vantage_point.type === "NETWORK" || jsonconnection.vantage_point.type === "network" ){
                        connection.vantagePoint.type = qlog01.VantagePointType.network;
                        connection.vantagePoint.flow = qlog01.VantagePointType.client;
                    }
                }

                if ( !connection.vantagePoint.type ){
                    connection.vantagePoint.type = qlog01.VantagePointType.unknown;
                    connection.vantagePoint.flow = qlog01.VantagePointType.unknown;
                    connection.vantagePoint.name = "No VantagePoint set";
                }

                connection.eventFieldNames = jsonconnection.event_fields;
                connection.commonFields = jsonconnection.common_fields;
                connection.configuration = jsonconnection.configuration || {};

                connection.setEventParser( new EventFieldsParser() );

                for ( const evt of connection.getEvents() ){
                    const data = connection.parseEvent(evt).data;
                    if ( data.frames ) {
                        for ( const frame of data.frames ){
                            if ( frame.frame_type ){
                                frame.frame_type = frame.frame_type.toLowerCase();
                            }
                        }
                    }
                    
                    if ( data.packet_type ){
                        data.packet_type = data.packet_type.toLowerCase();
                        data.type = data.packet_type; // older version of draft-01 had .type instead of .packet_type // FIXME: remove!
                    }

                    // if ( data.header && data.header.packet_number !== undefined ){
                    //     // some draft-00 traces use simple ints instead of strings for packet numbers. This breaks things.
                    //     data.header.packet_number = "" + data.header.packet_number;
                    // }
                }

                QlogLoader.fixPreviousInto01( connection );
            }
        }

        return group;
    }

    protected static fromPreSpec(json:any) : QlogConnectionGroup {

        const fileContents:qlogPreSpec.IQLog = json as qlogPreSpec.IQLog;

        console.log("QlogLoader:fromPreSpec : ", fileContents, fileContents.connections);

        // QLog00 toplevel structure contains a list of connections
        // most files currently just contain a single connection, but the idea is to allow bundling connections on a single file
        // for example 1 log for the server and 1 for the client and 1 for the network, all contained in 1 file
        // This is why we call it a ConnectionGroup here, instead of QlogFile or something
        const group = new QlogConnectionGroup();
        group.version = fileContents.qlog_version;
        group.description = fileContents.description || "";

        for ( const jsonconnection of fileContents.connections ){

            const connection = new QlogConnection(group);

            // metadata can be just a string, so use that
            // OR it can be a full object, in which case we want just the description here
            let description = "no description";
            if ( jsonconnection.metadata ){
                if ( typeof jsonconnection.metadata === "string" ){
                    description = jsonconnection.metadata;
                }
                else if ( jsonconnection.metadata.description ){ // can be empty object {}
                    description = jsonconnection.metadata.description;
                }
            }

            if ( jsonconnection.vantagepoint ){
                connection.vantagePoint = {} as qlog01.IVantagePoint;
                if ( jsonconnection.vantagepoint === "SERVER" || (jsonconnection.vantagepoint as any) === "server" ){
                    connection.vantagePoint.type = qlog01.VantagePointType.server;
                }
                else if ( jsonconnection.vantagepoint === "CLIENT" || (jsonconnection.vantagepoint as any) === "client" ){
                    connection.vantagePoint.type = qlog01.VantagePointType.client;
                }
                else if ( jsonconnection.vantagepoint === "NETWORK" || (jsonconnection.vantagepoint as any) === "network" ){
                    connection.vantagePoint.type = qlog01.VantagePointType.network;
                    connection.vantagePoint.flow = qlog01.VantagePointType.client;
                }
            }

            connection.title = description;
            connection.description = description;

            connection.eventFieldNames = jsonconnection.fields;
            connection.setEvents( jsonconnection.events as any );

            connection.setEventParser( new PreSpecEventParser() );
        }

        return group;
    }
}


// tslint:disable max-classes-per-file
export class EventFieldsParser implements IQlogEventParser {

    private timeTrackingMethod = TimeTrackingMethod.ABSOLUTE_TIME;
    
    private addTime:number = 0;
    private subtractTime:number = 0;
    private timeMultiplier:number = 1;
    private _timeOffset:number = 0;

    private timeIndex:number = 0;
    private categoryIndex:number = 1;
    private nameIndex:number = 2;
    private dataIndex:number = 3;

    private categoryCommon:string = "unknown";
    private nameCommon:string = "unknown";


    private currentEvent:IQlogRawEvent|undefined;

    public get relativeTime():number {
        if ( this.timeIndex === -1 ) {
            return 0;
        }

        // TODO: now we do this calculation whenever we access the .time property
        // probably faster to do this in a loop for each event in init(), but this doesn't fit well with the streaming use case...
        // can probably do the parseFloat up-front though?
        // return parseFloat((this.currentEvent as IQlogRawEvent)[this.timeIndex]) * this.timeMultiplier - this.subtractTime + this._timeOffset;
        return parseFloat((this.currentEvent as IQlogRawEvent)[this.timeIndex]) * this.timeMultiplier - this.subtractTime + this._timeOffset;
    }

    public get absoluteTime():number {
        if ( this.timeIndex === -1 ) {
            return 0;
        }

        return parseFloat((this.currentEvent as IQlogRawEvent)[this.timeIndex]) * this.timeMultiplier + this.addTime + this._timeOffset;
    }

    public getAbsoluteStartTime():number {
        // when relative time, this is reference_time, which is stored in this.addTime
        // when absolute time, this is the time of the first event, which is stored in this.subtractTime
        if ( this.timeTrackingMethod === TimeTrackingMethod.RELATIVE_TIME ){
            return this.addTime;
        }
        else if ( this.timeTrackingMethod === TimeTrackingMethod.ABSOLUTE_TIME ){
            return this.subtractTime;
        }
        else {
            console.error("QlogLoader: No proper startTime present in qlog file. This tool doesn't support delta_time yet!");

            return 0;
        }
    }

    public get timeOffset():number {
        return this._timeOffset;
    }
    public get category():string {
        if ( this.categoryIndex === -1 ) {
            return this.categoryCommon;
        }

        return (this.currentEvent as IQlogRawEvent)[this.categoryIndex].toLowerCase();
    }
    public get name():string {
        if ( this.nameIndex === -1 ) {
            return this.nameCommon;
        }

        return (this.currentEvent as IQlogRawEvent)[this.nameIndex].toLowerCase();
    }
    public set name(val:string) {
        if ( this.nameIndex === -1 ) {
            return;
        }

        (this.currentEvent as IQlogRawEvent)[this.nameIndex] = val;
    }
    public get data():any|undefined {
        if ( this.dataIndex === -1 ) {
            return {};
        }

        return (this.currentEvent as IQlogRawEvent)[this.dataIndex];
    }

    public timeToMilliseconds(time: number | string): number {
        return parseFloat(time as any) * this.timeMultiplier;
    }

    public getTimeTrackingMethod():TimeTrackingMethod {
        return this.timeTrackingMethod;
    }

    public init( trace:QlogConnection ) {
        this.currentEvent = undefined;

        if (trace.commonFields ){
            if ( trace.commonFields.category || trace.commonFields.CATEGORY ) {
                this.categoryCommon = trace.commonFields.category || trace.commonFields.CATEGORY;
                this.categoryCommon = this.categoryCommon.toLowerCase();
            }
            if ( trace.commonFields.event || trace.commonFields.EVENT_TYPE ) {
                this.nameCommon = trace.commonFields.event || trace.commonFields.EVENT_TYPE;
                this.nameCommon = this.nameCommon.toLowerCase();
            }
        }

        // events are a flat array of values
        // the "column names" are in a separate list: eventFieldNames
        // to know which index of the flat array maps to which type of value, we need to match indices to field types first
        let eventFieldNames = trace.eventFieldNames.slice(); // copy because to tolowercase
        eventFieldNames = eventFieldNames.map( (val) => val.toLowerCase() ); // 00 is uppercase, 01 lowercase

        this.categoryIndex  = eventFieldNames.indexOf( "category" ); // FIXME: get this string from the qlog definitions somewhere
        this.nameIndex      = eventFieldNames.indexOf( "event_type" );
        if ( this.nameIndex === -1 ) {
            this.nameIndex      = eventFieldNames.indexOf( "event" ); // 00 is event_type, 01 is event
        }
        this.dataIndex      = eventFieldNames.indexOf( "data" );



        // We have two main time representations: relative or absolute
        // We want to convert between the two to give outside users their choice of both
        // to get ABSOLUTE time:
        // if relative timestamps : need to do reference_time + time
        // if absolute timestamps : need to do 0 + time
        // to get RELATIVE time:
        // if relative: need to return time - 0
        // if absolute: need to return time - events[0].time

        // so: we need two variables: addTime and subtractTime

        this.timeIndex = eventFieldNames.indexOf("time"); // typically 0
        if ( this.timeIndex === -1 ){
            this.timeIndex = eventFieldNames.indexOf("relative_time"); // typically 0

            if ( this.timeIndex === -1 ){
                this.timeIndex = eventFieldNames.indexOf("delta_time"); // typically 0 

                if ( this.timeIndex === -1 ) {
                    console.error("QlogLoader: No proper timestamp present in qlog file. Pick one of either time, relative_time or delta_time", trace.eventFieldNames);
                }
                else {

                    // DELTA_TIME is a weird one: timestamps are encoded relatively to the -previous- one
                    // since we don't always want to loop over events in-order, we support this using a pre-processing step here
                    // we basically construct the ABSOLUTE timestamps for all the events and then pretend we had absolute all along
                    // this only works if we have the events set here though...
                    this.timeTrackingMethod = TimeTrackingMethod.ABSOLUTE_TIME;

                    const allEvents = trace.getEvents()
                    if ( !allEvents || allEvents.length === 0 ) {
                        console.error("QlogLoader: DELTA_TIME requires all events to be set before setEventParser is called... was not the case here!");
                    }
                    else {
                        // allow both a start time in commonFields.reference_time AND as the first event element
                        if ( trace.commonFields && trace.commonFields.reference_time !== undefined ){
                            this.addTime = 0;
                            this.subtractTime = parseFloat(trace.commonFields.reference_time);
                            allEvents[0][this.timeIndex] += this.subtractTime; // so we can start from event 1 below
                            // note: it's not just = this.subtractTime: the ref_time could be set when the process starts and stay the same for many connections that start later 
                            // put differently: first timestamp isn't always 0
                        }
                        else {
                            this.addTime = 0;
                            this.subtractTime = parseFloat( allEvents[0][this.timeIndex] );
                        }
                    }

                    // transform the timestamps into absolute timestamps starting from the initial time found above
                    // e.g., initial time is 1500, then we have 3, 5, 7
                    // then the total timestamps should be 1500, 1503, 1508, 1515
                    let previousTime = this.subtractTime;
                    for ( let i = 1; i < allEvents.length; ++i  ) { // start at 1, because the first event can be special, see above
                        // console.log("Starting at ", allEvents[i][ this.timeIndex ], "+", previousTime, " gives ", parseFloat(allEvents[i][ this.timeIndex ]) + previousTime);
                        allEvents[i][ this.timeIndex ] = parseFloat(allEvents[i][ this.timeIndex ]) + previousTime;
                        previousTime = allEvents[i][ this.timeIndex ];
                    }
                }
            }
            else {
                // Timestamps are in RELATIVE time
                this.timeTrackingMethod = TimeTrackingMethod.RELATIVE_TIME;

                if ( trace.commonFields && trace.commonFields.reference_time !== undefined ){
                    this.addTime = parseFloat(trace.commonFields.reference_time);
                    this.subtractTime = 0;
                }
                else {
                    console.error("QlogLoader: Using relative_time but no reference_time found in common_fields. Assuming 0.", trace.eventFieldNames, trace.commonFields);
                    this.addTime = 0;
                    this.subtractTime = 0;
                }
            }
        }
        else{
            // Timestamps are in ABSOLUTE time
            this.timeTrackingMethod = TimeTrackingMethod.ABSOLUTE_TIME;
            this.addTime = 0;
            this.subtractTime = parseFloat( trace.getEvents()[0][this.timeIndex] );
        }

        if ( trace.configuration && trace.configuration.time_units && trace.configuration.time_units === "us" ){
            this.timeMultiplier = 0.001; // timestamps are in microseconds, we want to view everything in milliseconds
        }

        if ( trace.configuration && trace.configuration.time_offset ){
            this._timeOffset = parseFloat( trace.configuration.time_offset ) * this.timeMultiplier;
        }

        this.addTime        *= this.timeMultiplier;
        this.subtractTime   *= this.timeMultiplier;
    }

    public setReferenceTime( time:number ) : void {
        this.addTime = time;
        this.addTime *= this.timeMultiplier;
    }

    public load( evt:IQlogRawEvent ) : IQlogEventParser {
        this.currentEvent = evt;

        return this;
    }
}

// tslint:disable max-classes-per-file
export class PreSpecEventParser implements IQlogEventParser {

    private currentEvent:IQlogRawEvent|undefined;

    public get relativeTime():number {
        return parseFloat( (this.currentEvent as IQlogRawEvent)[0] );
    }

    public get absoluteTime():number {
        return this.relativeTime;
    }

    public getAbsoluteStartTime():number {
        return 0;
    }

    public get category():string {
        return (this.currentEvent as IQlogRawEvent)[1];
    }
    public get name():string {
        return (this.currentEvent as IQlogRawEvent)[2];
    }
    public set name(val:string) {
        (this.currentEvent as IQlogRawEvent)[2] = val;
    }
    public get trigger():string {
        return (this.currentEvent as IQlogRawEvent)[3];
    }
    public get data():any|undefined {
        return (this.currentEvent as IQlogRawEvent)[4];
    }

    public get timeOffset():number {
        return 0;
    }

    public init( trace:QlogConnection ) {
        this.currentEvent = undefined;
    }

    public timeToMilliseconds(time: number | string): number {
        return parseFloat(time as any);
    }

    public getTimeTrackingMethod():TimeTrackingMethod {
        return TimeTrackingMethod.RELATIVE_TIME;
    }

    public setReferenceTime(time:number) {
        // nothing to set I'm afraid... this type of trace isn't properly supported anyway
    }

    public load( evt:IQlogRawEvent ) : IQlogEventParser {
        this.currentEvent = evt;

        return this;
    }
}
