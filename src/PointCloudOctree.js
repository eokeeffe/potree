

/**
 * Stands in place for invisible or unloaded octree nodes.
 * If a proxy node becomes visible and its geometry has not been loaded,
 * loading will begin.
 * If it is visible and the geometry has been loaded, the proxy node will 
 * be replaced with a point cloud node (THREE.PointCloud as of now)
 */
Potree.PointCloudOctreeProxyNode = function(geometryNode){
	THREE.Object3D.call( this );
	
	this.geometryNode = geometryNode;
	this.boundingBox = geometryNode.boundingBox;
	this.boundingSphere = this.boundingBox.getBoundingSphere();
	this.name = geometryNode.name;
	this.level = geometryNode.level;
	this.numPoints = geometryNode.numPoints;
}

Potree.PointCloudOctreeProxyNode.prototype = Object.create(THREE.Object3D.prototype);








Potree.ProfileRequest = function(start, end, width, depth, callback){
	this.start = start;
	this.end = end;
	this.width = width;
	this.depth = depth;
	
	//var up = start.clone();
	//up.y += 10;
	//this.plane = new THREE.Plane().setFromCoplanarPoints(start, end, up);
	this.callback = callback;
	this.loadQueue = [];
	
	var center = new THREE.Vector3().addVectors(end, start).multiplyScalar(0.5);
	var length = new THREE.Vector3().subVectors(end, start).length();
	var side = new THREE.Vector3().subVectors(end, start).normalize();
	var up = new THREE.Vector3(0, 1, 0);
	var forward = new THREE.Vector3().crossVectors(side, up).normalize();
	var N = forward;
	this.plane = new THREE.Plane().setFromNormalAndCoplanarPoint(N, start);
};








Potree.PointCloudOctree = function(geometry, material){
	THREE.Object3D.call( this );
	
	Potree.PointCloudOctree.lru = Potree.PointCloudOctree.lru || new LRU();
	
	this.pcoGeometry = geometry;
	this.boundingBox = this.pcoGeometry.tightBoundingBox;
	this.boundingSphere = this.boundingBox.getBoundingSphere();
	this.material = material || new Potree.PointCloudMaterial();
	this.visiblePointsTarget = 2*1000*1000;
	this.minimumNodePixelSize = 150;
	this.level = 0;
	this.position.sub(geometry.offset);
	this.updateMatrix();
	
	this.LODDistance = 20;
	this.LODFalloff = 1.3;
	this.LOD = 4;
	this.showBoundingBox = false;
	this.boundingBoxNodes = [];
	this.loadQueue = [];
	this.visibleBounds = new THREE.Box3();	
	this.profileRequests = [];
	this.visibleNodes = [];
	this.visibleGeometry = [];
	this.pickTarget;
	this.generateDEM = false;
	
	var rootProxy = new Potree.PointCloudOctreeProxyNode(this.pcoGeometry.root);
	this.add(rootProxy);
}

Potree.PointCloudOctree.prototype = Object.create(THREE.Object3D.prototype);

Potree.PointCloudOctree.prototype.updateVisibleBounds = function(){

	var leafNodes = [];
	for(var i = 0; i < this.visibleNodes.length; i++){
		var element = this.visibleNodes[i];
		var node = element.node;
		var isLeaf = true;
		
		for(var j = 0; j < node.children.length; j++){
			var child = node.children[j];
			if(child instanceof THREE.PointCloud){
				isLeaf = isLeaf && !child.visible;
			}
		}
		
		if(isLeaf){
			leafNodes.push(node);
		}
	}
	
	this.visibleBounds.min = new THREE.Vector3( Infinity, Infinity, Infinity );
	this.visibleBounds.max = new THREE.Vector3( - Infinity, - Infinity, - Infinity );
	for(var i = 0; i < leafNodes.length; i++){
		var node = leafNodes[i];
		
		this.visibleBounds.expandByPoint(node.boundingBox.min);
		this.visibleBounds.expandByPoint(node.boundingBox.max);
	}
	
}


Potree.PointCloudOctree.prototype.updateProfileRequests = function(){
	// check profile cut plane intersections
	for(var i = 0; i < this.profileRequests.length; i++){
		var profileRequest = this.profileRequests[i];
		var plane = profileRequest.plane;
		var start = profileRequest.start;
		var end = profileRequest.end;
		var depth = profileRequest.depth;
		
		var stack = [];
		stack.push(this);
		while(stack.length > 0){
			var object = stack.shift();
		
			if(object instanceof Potree.PointCloudOctreeProxyNode){
				var box = Potree.utils.computeTransformedBoundingBox(object.boundingBox, object.matrixWorld);
				
				var sphere = box.getBoundingSphere();
				if(Math.abs(plane.distanceToPoint(sphere.center)) < sphere.radius){
					profileRequest.loadQueue.push(object);
				}
			}
		
		
			if(object.level < depth){
				for(var i = 0; i < object.children.length; i++){
					var child = object.children[i];
					
					if(child instanceof Potree.PointCloudOctreeProxyNode || child instanceof THREE.PointCloud){
						stack.push(object.children[i]);
					}
				}
			}
		}
			
	}
	
	// schedule nodes needed for a profile request
	var finishedRequests = [];
	for(var i = 0; i < this.profileRequests.length; i++){
		var request = this.profileRequests[i];
		
		if(request.loadQueue.length > 0){
			var object = request.loadQueue[0];
			var geometryNode = object.geometryNode;
			if(geometryNode.loaded === true && object.parent !== undefined){
				var node = this.replaceProxy(object);
				node.updateMatrixWorld();
				node.matrixWorld.multiplyMatrices( node.parent.matrixWorld, node.matrix );
				
				//var boxHelper = new THREE.BoxHelper(node);
				//scene.add(boxHelper);
			}else{
				object.geometryNode.load();
			}
		}else{
			var points = this.getProfile(request.start, request.end, request.width, request.depth);
		
			request.callback({type: "finished", points: points});
			finishedRequests.push(request);
		}
	}
	
	for(var i = 0; i < finishedRequests.length; i++){
		var index = this.profileRequests.indexOf(finishedRequests[i]);
		if (index > -1) {
			this.profileRequests.splice(index, 1);
		}
	}
};

Potree.PointCloudOctree.prototype.updateMaterial = function(vn, camera, renderer){
	this.material.fov = camera.fov * (Math.PI / 180);
	this.material.screenWidth = renderer.domElement.clientWidth;
	this.material.screenHeight = renderer.domElement.clientHeight;
	this.material.spacing = this.pcoGeometry.spacing;
	this.material.near = camera.near;
	this.material.far = camera.far;
	this.material.uniforms.octreeSize.value = this.pcoGeometry.boundingBox.size().x;
	
	if(this.material.pointSizeType){
		if(this.material.pointSizeType === Potree.PointSizeType.ADAPTIVE 
			|| this.material.pointColorType === Potree.PointColorType.OCTREE_DEPTH){
			
			this.updateVisibilityTexture(this.material, vn);
		}
	}
};

Potree.PointCloudOctree.prototype.updatePointCloud = function(node, element, stack, visibleGeometryNames, renderer){
	this.numVisibleNodes++;
	this.numVisiblePoints += node.numPoints;
	node.material = this.material;
	this.visibleNodes.push(element);
	
	if(this.showBoundingBox && !node.boundingBoxNode){
		var boxHelper = new THREE.BoxHelper(node);
		this.add(boxHelper);
		this.boundingBoxNodes.push(boxHelper);
		node.boundingBoxNode = boxHelper;
		node.boundingBoxNode.matrixWorld.copy(node.matrixWorld);
	}else if(this.showBoundingBox){
		node.boundingBoxNode.visible = true;
		node.boundingBoxNode.matrixWorld.copy(node.matrixWorld);
	}else if(!this.showBoundingBox && node.boundingBoxNode){
		node.boundingBoxNode.visible = false;
	}
	
	if(this.generateDEM && node.level <= 2){
		if(!node.dem){
			node.dem = this.createDEM(node);
		}
	}
	
	for(var i = 0; i < node.children.length; i++){
		var child = node.children[i];
		var visible = visibleGeometryNames.indexOf(child.name) >= 0;
		if(visible){
			for(var j = 0; j < this.visibleGeometry.length; j++){
				if(this.visibleGeometry[j].node.name === child.name){
					stack.push({node: child, weight: this.visibleGeometry[j].weight});
					break;
				}
			};
		}
	}
}

Potree.PointCloudOctree.prototype.updateLoadQueue = function(vn){
	if(this.loadQueue.length > 0){
		if(this.loadQueue.length >= 2){
			this.loadQueue.sort(function(a,b){return b.weight - a.weight});
		}
		
		for(var i = 0; i < Math.min(5, this.loadQueue.length); i++){
			this.loadQueue[i].node.geometryNode.load();
		}
	}
}

Potree.PointCloudOctree.prototype.update = function(camera, renderer){
	this.visibleGeometry = [];
	this.loadQueue = [];
	this.visibleNodes = [];
	this.numVisibleNodes = 0;
	this.numVisiblePoints = 0;

	if(!this.visible){
		return;
	}

	this.updateMatrixWorld(true);

	this.visibleGeometry = this.getVisibleGeometry(camera, renderer);
	var visibleGeometryNames = [];
	
	for(var i = 0; i < this.visibleGeometry.length; i++){
		visibleGeometryNames.push(this.visibleGeometry[i].node.name);
	}
	
	for(var i = 0; i < this.profileRequests.length; i++){
		var profileRequest = this.profileRequests[i];
		profileRequest.loadQueue = [];
	}
	
	for(var i = 0; i < this.boundingBoxNodes.length; i++){
		this.boundingBoxNodes[i].visible = false;
	}
	
	
	
	
	
	this.hideDescendants(this.children[0]);
	
	var stack = [];
	stack.push({node: this.children[0], weight: 1});	//TODO don't do it like that
	while(stack.length > 0){
		var element = stack.shift();
		var node = element.node;
		var weight = element.weight;
		
		node.visible = true;
		
		node.matrixWorld.multiplyMatrices( node.parent.matrixWorld, node.matrix );
		
		if (node instanceof Potree.PointCloudOctreeProxyNode) {
			var geometryNode = node.geometryNode;
			if(geometryNode.loaded === true){
				this.replaceProxy(node);
			}else{
				this.loadQueue.push(element);
			}
		}else if(node instanceof THREE.PointCloud){
			if(node.pcoGeometry.loaded){
				Potree.PointCloudOctree.lru.touch(node.pcoGeometry);
				this.updatePointCloud(node, element, stack, visibleGeometryNames, renderer);
			}else{
				var proxy = new Potree.PointCloudOctreeProxyNode(node.pcoGeometry);
				var parent = node.parent;
				parent.remove(node);
				parent.add(proxy);
			}
		}
	}
	
	this.updateProfileRequests();
	this.updateVisibleBounds();
	this.updateLoadQueue();
	
	this.hideDescendants(this.children[0]);
	var vn = [];
	for(var i = 0; i < this.visibleNodes.length; i++){
		this.visibleNodes[i].node.visible = true;
		vn.push(this.visibleNodes[i].node);
	}
	
	// update visibility texture
	if(this.material.pointSizeType){
		if(this.material.pointSizeType === Potree.PointSizeType.ADAPTIVE 
			|| this.material.pointColorType === Potree.PointColorType.OCTREE_DEPTH){
			
			this.updateVisibilityTexture(this.material, vn);
		}
	}
	
	this.updateMaterial(vn, camera, renderer);
	
	Potree.PointCloudOctree.lru.freeMemory();
};

Potree.PointCloudOctree.prototype.getVisibleGeometry = function(camera, renderer){
	
	var visibleGeometry = [];
	var geometry = this.pcoGeometry;
	
	
	// create frustum in object space
	camera.updateMatrixWorld();
	var frustum = new THREE.Frustum();
	var viewI = camera.matrixWorldInverse;
	var world = this.matrixWorld;
	var proj = camera.projectionMatrix;
	var fm = new THREE.Matrix4().multiply(proj).multiply(viewI).multiply(world);
	frustum.setFromMatrix( fm );
	
	// calculate camera position in object space
	var view = camera.matrixWorld;
	var worldI = new THREE.Matrix4().getInverse(world);
	var camMatrixObject = new THREE.Matrix4().multiply(worldI).multiply(view);
	var camObjPos = new THREE.Vector3().setFromMatrixPosition( camMatrixObject );
	
	var sortWeightFunction = function(a, b){return b.weight - a.weight};
	
	var root = geometry.root;
	var stack = [];
	var pointCount = 0;
	
	var sphere = root.boundingBox.getBoundingSphere();
	var distance = sphere.center.distanceTo(camObjPos);
	//var weight = sphere.radius / distance;
	var weight = 1 / Math.max(0.1, sphere.center.distanceTo(camObjPos) - sphere.radius);
	stack.push({node: root, weight: weight});
	var nodesTested = 0;
	while(stack.length > 0){
		nodesTested++;
		var element = stack.shift();
		var node = element.node;
		
		var box = node.boundingBox;
		var sphere = node.boundingSphere;
		//var insideFrustum = frustum.intersectsSphere(sphere);
		var insideFrustum = frustum.intersectsBox(box);
	
		
		var visible = insideFrustum; // && node.level <= 3;
		//visible = visible && "r0".indexOf(node.name) === 0;
		//visible = visible && node.level === 0;
		
		if(!visible){
			continue;
		}
		
		if(pointCount + node.numPoints > this.visiblePointsTarget){
			break;
		}
		
		pointCount += node.numPoints;
		visibleGeometry.push(element);
		
		for(var i = 0; i < 8; i++){
			if(!node.children[i]){
				continue;
			}
		
			var child = node.children[i];
			
			var sphere = child.boundingSphere;
			var distance = sphere.center.distanceTo(camObjPos);
			var radius = sphere.radius;
			var weight = sphere.radius / distance;
			//var weight = (1 / Math.max(0.001, distance - radius)) * distance;
			
			// discarding nodes which are very small when projected onto the screen
			// TODO: pr threshold was a value choosen by trial & error. Validate that this is fine.
			// see http://stackoverflow.com/questions/21648630/radius-of-projected-sphere-in-screen-space
			var fov = camera.fov / 2 * Math.PI / 180.0;
			var pr = 1 / Math.tan(fov) * radius / Math.sqrt(distance * distance - radius * radius);
			
			var screenPixelRadius = renderer.domElement.clientHeight * pr;
			if(screenPixelRadius < this.minimumNodePixelSize){
				continue;
			}
			
			weight = pr;
			if(distance - radius < 0){
				weight = Number.MAX_VALUE;
			}
			
			if(stack.length === 0){
				stack.push({node: child, weight: weight});
			}else{
				var ipos = 0;
			
				for(var j = 0; j < stack.length; j++){
					if(weight > stack[j].weight){
						var ipos = j;
						break;
					}else if(j == stack.length -1){
						ipos = stack.length;
						break;
					}
					
					
				}
				
				stack.splice(ipos, 0, {node: child, weight: weight});
			}
		}

		var a = 1;
	}
	
	return visibleGeometry;
};

Potree.PointCloudOctree.prototype.updateVisibilityTexture = function(material, visibleNodes){

	if(!material){
		return;
	}
	
	var texture = material.visibleNodesTexture;
    var data = texture.image.data;
	
	// copy array
	visibleNodes = visibleNodes.slice();
	
	// sort by level and index, e.g. r, r0, r3, r4, r01, r07, r30, ...
	var sort = function(a, b){
		var na = a.name;
		var nb = b.name;
		if(na.length != nb.length) return na.length - nb.length;
		if(na < nb) return -1;
		if(na > nb) return 1;
		return 0;
	};
	visibleNodes.sort(sort);
	
	var visibleNodeNames = {};
	for(var i = 0; i < visibleNodes.length; i++){
		visibleNodeNames[visibleNodes[i].name] = true;
	}
	
	for(var i = 0; i < visibleNodes.length; i++){
		var node = visibleNodes[i];
		
		var children = [];
		for(var j = 0; j < node.children.length; j++){
			var child = node.children[j];
			if(child instanceof THREE.PointCloud && child.visible && visibleNodeNames[child.name]){
				children.push(child);
			}
		}
		children.sort(function(a, b){
			if(a.name < b.name) return -1;
			if(a.name > b.name) return 1;
			return 0;
		});
		
		data[i*3 + 0] = 0;
		data[i*3 + 1] = 0;
		data[i*3 + 2] = 0;
		for(var j = 0; j < children.length; j++){
			var child = children[j];
			var index = parseInt(child.name.substr(-1));
			data[i*3 + 0] += Math.pow(2, index);
			
			if(j === 0){
				var vArrayIndex = visibleNodes.indexOf(child);
				data[i*3 + 1] = vArrayIndex - i;
			}
			
		}
	}
	
	
	texture.needsUpdate = true;
}

Potree.PointCloudOctree.prototype.nodesOnRay = function(nodes, ray){
	var nodesOnRay = [];

	var _ray = ray.clone();
	for(var i = 0; i < nodes.length; i++){
		var node = nodes[i].node;
		//var inverseWorld = new THREE.Matrix4().getInverse(node.matrixWorld);
		var sphere = node.boundingSphere.clone().applyMatrix4(node.matrixWorld);
		
		if(_ray.isIntersectionSphere(sphere)){
			nodesOnRay.push(node);
		}
	}
	
	return nodesOnRay;
};

Potree.PointCloudOctree.prototype.updateMatrixWorld = function( force ){
	//node.matrixWorld.multiplyMatrices( node.parent.matrixWorld, node.matrix );
	
	if ( this.matrixAutoUpdate === true ) this.updateMatrix();

	if ( this.matrixWorldNeedsUpdate === true || force === true ) {

		if ( this.parent === undefined ) {

			this.matrixWorld.copy( this.matrix );

		} else {

			this.matrixWorld.multiplyMatrices( this.parent.matrixWorld, this.matrix );

		}

		this.matrixWorldNeedsUpdate = false;

		force = true;

	}
};


Potree.PointCloudOctree.prototype.replaceProxy = function(proxy){
	
	var geometryNode = proxy.geometryNode;
	if(geometryNode.loaded === true){
		var geometry = geometryNode.geometry;
		var node = new THREE.PointCloud(geometry, this.material);
		node.name = proxy.name;
		node.level = proxy.level;
		node.numPoints = proxy.numPoints;
		node.boundingBox = geometry.boundingBox;
		node.boundingSphere = node.boundingBox.getBoundingSphere();
		node.pcoGeometry = geometryNode;
		var parent = proxy.parent;
		parent.remove(proxy);
		parent.add(node);
		
		node.matrixWorld.multiplyMatrices( node.parent.matrixWorld, node.matrix );

		for(var i = 0; i < 8; i++){
			if(geometryNode.children[i] !== undefined){
				var child = geometryNode.children[i];
				var childProxy = new Potree.PointCloudOctreeProxyNode(child);
				node.add(childProxy);
			}
		}
		
		return node;
	}
}

Potree.PointCloudOctree.prototype.hideDescendants = function(object){
	var stack = [];
	for(var i = 0; i < object.children.length; i++){
		var child = object.children[i];
		if(child.visible){
			stack.push(child);
		}
	}
	
	while(stack.length > 0){
		var object = stack.shift();
		
		object.visible = false;
		
		for(var i = 0; i < object.children.length; i++){
			var child = object.children[i];
			if(child.visible){
				stack.push(child);
			}
		}
	}
}

Potree.PointCloudOctree.prototype.moveToOrigin = function(){
    this.position.set(0,0,0);
    this.updateMatrixWorld(true);
    var box = this.boundingBox;
    var transform = this.matrixWorld;
    var tBox = Potree.utils.computeTransformedBoundingBox(box, transform);
    this.position.set(0,0,0).sub(tBox.center());
}

Potree.PointCloudOctree.prototype.moveToGroundPlane = function(){
    this.updateMatrixWorld(true);
    var box = this.boundingBox;
    var transform = this.matrixWorld;
    var tBox = Potree.utils.computeTransformedBoundingBox(box, transform);
    this.position.y += -tBox.min.y;
}

Potree.PointCloudOctree.prototype.getBoundingBoxWorld = function(){
	this.updateMatrixWorld(true);
    var box = this.boundingBox;
    var transform = this.matrixWorld;
    var tBox = Potree.utils.computeTransformedBoundingBox(box, transform);
	
	return tBox;
}

/**
 * returns points inside the profile points
 *
 * maxDepth:		search points up to the given octree depth
 *
 *
 * The return value is an array with all segments of the profile path
 *  var segment = {
 * 		start: 	THREE.Vector3,
 * 		end: 	THREE.Vector3,
 * 		points: {}
 * 		project: function()
 *  };
 *
 * The project() function inside each segment can be used to transform
 * that segments point coordinates to line up along the x-axis.
 *
 *
 */
Potree.PointCloudOctree.prototype.getPointsInProfile = function(profile, maxDepth){
	var points = [];
	
	var mileage = 0;
	for(var i = 0; i < profile.points.length - 1; i++){
		var start = profile.points[i];
		var end = profile.points[i+1];
		var ps = this.getProfile(start, end, profile.width, maxDepth);
		
		var project = function(_start, _end, _mileage){
			var start = _start;
			var end = _end;
			var mileage = _mileage;
			
			var xAxis = new THREE.Vector3(1,0,0);
			var dir = new THREE.Vector3().subVectors(end, start);
			dir.y = 0;
			dir.normalize();
			var alpha = Math.acos(xAxis.dot(dir));
			if(dir.z > 0){
				alpha = -alpha;
			}
			
			
			return function(position){
						
				var toOrigin = new THREE.Matrix4().makeTranslation(-start.x, -start.y, -start.z);
				var alignWithX = new THREE.Matrix4().makeRotationY(-alpha);
				var applyMileage = new THREE.Matrix4().makeTranslation(mileage, 0, 0);


				var pos = position.clone();
				pos.applyMatrix4(toOrigin);
				pos.applyMatrix4(alignWithX);
				pos.applyMatrix4(applyMileage);
				
				return pos;
			};
			
		}(start, end, mileage)
		
		var segment = {
			start: start,
			end: end,
			points: ps,
			project: project
		};
		
		points.push(segment);

		mileage += start.distanceTo(end);
	}
	
	return points;
};

/**
 * returns points inside the given profile bounds.
 *
 * start: 	
 * end: 	
 * width:	
 * depth:		search points up to the given octree depth
 * callback:	if specified, points are loaded before searching
 *				
 *
 */
Potree.PointCloudOctree.prototype.getProfile = function(start, end, width, depth, callback){
	if(callback !== undefined){
		this.profileRequests.push(new Potree.ProfileRequest(start, end, width, depth, callback));
	}else{
		var stack = [];
		stack.push(this);
		
		var center = new THREE.Vector3().addVectors(end, start).multiplyScalar(0.5);
		var length = new THREE.Vector3().subVectors(end, start).length();
		var side = new THREE.Vector3().subVectors(end, start).normalize();
		var up = new THREE.Vector3(0, 1, 0);
		var forward = new THREE.Vector3().crossVectors(side, up).normalize();
		var N = forward;
		var cutPlane = new THREE.Plane().setFromNormalAndCoplanarPoint(N, start);
		var halfPlane = new THREE.Plane().setFromNormalAndCoplanarPoint(side, center);
		
		var inside = null;
		
		
		while(stack.length > 0){
			var object = stack.shift();
			
			
			var pointsFound = 0;
			
			if(object instanceof THREE.PointCloud){
				var geometry = object.geometry;
				var positions = geometry.attributes.position;
				var p = positions.array;
				var numPoints = object.numPoints;
				
				if(!inside){
					inside = {};
					
					for (var property in geometry.attributes) {
						if (geometry.attributes.hasOwnProperty(property)) {
							if(property === "indices"){
							
							}else{
								inside[property] = [];
							}
						}
					}
				}
				
				for(var i = 0; i < numPoints; i++){
					var pos = new THREE.Vector3(p[3*i], p[3*i+1], p[3*i+2]);
					pos.applyMatrix4(this.matrixWorld);
					var distance = Math.abs(cutPlane.distanceToPoint(pos));
					var centerDistance = Math.abs(halfPlane.distanceToPoint(pos));
					
					if(distance < width / 2 && centerDistance < length / 2){
						//inside.push(pos);
						
						for (var property in geometry.attributes) {
							if (geometry.attributes.hasOwnProperty(property)) {
							
								if(property === "position"){
									inside[property].push(pos);
								}else if(property === "indices"){
									// skip indices
								}else{
									var values = geometry.attributes[property];
									if(values.itemSize === 1){
										inside[property].push(values.array[i + j]);
									}else{
										var value = [];
										for(var j = 0; j < values.itemSize; j++){
											value.push(values.array[i*values.itemSize + j]);
										}
										inside[property].push(value);
									}
								}
								
							}
						}
						
						
						pointsFound++;
					}
				}
			}
			
			//console.log("traversing: " + object.name + ", #points found: " + pointsFound);
			
			if(object == this || object.level < depth){
				for(var i = 0; i < object.children.length; i++){
					var child = object.children[i];
					if(child instanceof THREE.PointCloud){
						var sphere = child.boundingSphere.clone().applyMatrix4(child.matrixWorld);
						if(cutPlane.distanceToSphere(sphere) < sphere.radius){
							stack.push(child);	
						}			
					}
				}
			}
		}
		
		inside.numPoints = inside.position.length;
		
		var project = function(_start, _end){
			var start = _start;
			var end = _end;
			
			var xAxis = new THREE.Vector3(1,0,0);
			var dir = new THREE.Vector3().subVectors(end, start);
			dir.y = 0;
			dir.normalize();
			var alpha = Math.acos(xAxis.dot(dir));
			if(dir.z > 0){
				alpha = -alpha;
			}
			
			
			return function(position){
						
				var toOrigin = new THREE.Matrix4().makeTranslation(-start.x, -start.y, -start.z);
				var alignWithX = new THREE.Matrix4().makeRotationY(-alpha);

				var pos = position.clone();
				pos.applyMatrix4(toOrigin);
				pos.applyMatrix4(alignWithX);
				
				return pos;
			};
			
		}(start, end)
		
		inside.project = project;
		
		return inside;
	}
}

///**
// *
// * amount: minimum number of points to remove
// */
//Potree.PointCloudOctree.disposeLeastRecentlyUsed = function(amount){
//	
//	return;
//	
//	var freed = 0;
//	do{
//		if(!Potree.PointCloudOctree.lru.first){
//			return;
//		}
//	
//		var node = Potree.PointCloudOctree.lru.first.node;
//		if(node.visible){
//			return;
//		}
//		
//		var parent = node.parent;
//		var geometry = node.geometry;
//		var pcoGeometry = node.pcoGeometry;
//		var proxy = new Potree.PointCloudOctreeProxyNode(pcoGeometry);
//	
//		var result = Potree.PointCloudOctree.disposeNode(node);
//		freed += result.freed;
//		
//		parent.add(proxy);
//		
//		if(result.numDeletedNodes == 0){
//			break;
//		}
//	}while(freed < amount);
//}
//
//Potree.PointCloudOctree.disposeNode = function(node){
//	
//	var freed = 0;
//	var numDeletedNodes = 0;
//	var descendants = [];
//	
//	node.traverse(function(object){
//		descendants.push(object);
//	});
//	
//	for(var i = 0; i < descendants.length; i++){
//		var descendant = descendants[i];
//		if(descendant instanceof THREE.PointCloud){
//			freed += descendant.pcoGeometry.numPoints;
//			descendant.pcoGeometry.dispose();
//			descendant.geometry.dispose();
//			Potree.PointCloudOctree.lru.remove(descendant);
//			numDeletedNodes++;
//			
//			console.log("disposed: " + node.name + "\t, " + renderer.info.memory.geometries + ", " + Potree.PointCloudOctree.lru.elements);
//		}
//	}
//	
//	Potree.PointCloudOctree.lru.remove(node);
//	node.parent.remove(node);
//	
//	return {
//		"freed": freed,
//		"numDeletedNodes": numDeletedNodes
//	};
//}

Potree.PointCloudOctree.prototype.getVisibleExtent = function(){
	return this.visibleBounds.applyMatrix4(this.matrixWorld);
};

/**
 *
 *
 *
 * params.pickWindowSize:	Look for points inside a pixel window of this size.
 * 							Use odd values: 1, 3, 5, ...
 * 
 * 
 * TODO: only draw pixels that are actually read with readPixels(). 
 * 
 */
Potree.PointCloudOctree.prototype.pick = function(renderer, camera, ray, params){
	// this function finds intersections by rendering point indices and then checking the point index at the mouse location.
	// point indices are 3 byte and rendered to the RGB component.
	// point cloud node indices are 1 byte and stored in the ALPHA component.
	// this limits picking capabilities to 256 nodes and 2^24 points per node. 

	var params = params || {};
	var pickWindowSize = params.pickWindowSize || 17;
	
	var nodes = this.nodesOnRay(this.visibleNodes, ray);
	
	if(nodes.length === 0){
		return null;
	}
	
	var width = Math.ceil(renderer.domElement.clientWidth);
	var height = Math.ceil(renderer.domElement.clientHeight);
	
	var pixelPos = new THREE.Vector3().addVectors(camera.position, ray.direction).project(camera);
	pixelPos.addScalar(1).multiplyScalar(0.5);
	pixelPos.x *= width;
	pixelPos.y *= height
	
	if(!this.pickTarget){
		this.pickTarget = new THREE.WebGLRenderTarget( 
			1, 1, 
			{ minFilter: THREE.LinearFilter, 
			magFilter: THREE.NearestFilter, 
			format: THREE.RGBAFormat } 
		);
	}else if(this.pickTarget.width != width || this.pickTarget.height != height){
		this.pickTarget.dispose();
		this.pickTarget = new THREE.WebGLRenderTarget( 
			1, 1, 
			{ minFilter: THREE.LinearFilter, 
			magFilter: THREE.NearestFilter, 
			format: THREE.RGBAFormat } 
		);
	}
	this.pickTarget.setSize(width, height);
	
	// setup pick material.
	// use the same point size functions as the main material to get the same point sizes.
	if(!this.pickMaterial){
		this.pickMaterial = new Potree.PointCloudMaterial();
		this.pickMaterial.pointColorType = Potree.PointColorType.POINT_INDEX;
		this.pickMaterial.pointSizeType = Potree.PointSizeType.FIXED;
	}
	
	this.pickMaterial.pointSizeType = this.material.pointSizeType;
	this.pickMaterial.size = this.material.size;
	
	if(this.pickMaterial.pointSizeType === Potree.PointSizeType.ADAPTIVE){
		this.updateVisibilityTexture(this.pickMaterial, nodes);
	}
	
	this.pickMaterial.fov 			= this.material.fov;
	this.pickMaterial.screenWidth 	= this.material.screenWidth;
	this.pickMaterial.screenHeight 	= this.material.screenHeight;
	this.pickMaterial.spacing 		= this.material.spacing;
	this.pickMaterial.near 			= this.material.near;
	this.pickMaterial.far 			= this.material.far;
	this.pickMaterial.pointShape 	= this.material.pointShape;
	
	

	var _gl = renderer.context;
	
	_gl.enable(_gl.SCISSOR_TEST);
	_gl.scissor(pixelPos.x - (pickWindowSize - 1) / 2, pixelPos.y - (pickWindowSize - 1) / 2,pickWindowSize,pickWindowSize);
	_gl.disable(_gl.SCISSOR_TEST);
	
	var material = this.pickMaterial;
	
	renderer.setRenderTarget( this.pickTarget );
	
	renderer.setDepthTest( material.depthTest );
	renderer.setDepthWrite( material.depthWrite )
	renderer.setBlending( THREE.NoBlending );
	
	renderer.clear( renderer.autoClearColor, renderer.autoClearDepth, renderer.autoClearStencil );
	
	//TODO: UGLY HACK CHAMPIONSHIP SUBMISSION!! drawing first node does not work properly so we draw it twice.
	if(nodes.length > 0){
		nodes.push(nodes[0]);
	}
	
	for(var i = 0; i < nodes.length; i++){
		var object = nodes[i];
		var geometry = object.geometry;
		
		if(!geometry.attributes.indices.buffer){
			continue;
		}
		
		material.pcIndex = i;
		
		if(material.program){
			var program = material.program.program;
			_gl.useProgram( program );
			//_gl.disable( _gl.BLEND );
			
			var attributePointer = _gl.getAttribLocation(program, "indices");
			var attributeSize = 4;
			_gl.bindBuffer( _gl.ARRAY_BUFFER, geometry.attributes.indices.buffer );
			//if(!bufferSubmitted){
			//	_gl.bufferData( _gl.ARRAY_BUFFER, new Uint8Array(geometry.attributes.indices.array), _gl.STATIC_DRAW );
			//	bufferSubmitted = true;
			//}
			_gl.enableVertexAttribArray( attributePointer );
			_gl.vertexAttribPointer( attributePointer, attributeSize, _gl.UNSIGNED_BYTE, true, 0, 0 ); 
		
			_gl.uniform1f(material.program.uniforms.pcIndex, material.pcIndex);
		}	
		
		renderer.renderBufferDirect(camera, [], null, material, geometry, object);
	}
	
	var pixelCount = pickWindowSize * pickWindowSize;
	var buffer = new ArrayBuffer(pixelCount*4);
	var pixels = new Uint8Array(buffer);
	var ibuffer = new Uint32Array(buffer);
	renderer.context.readPixels(
		pixelPos.x - (pickWindowSize-1) / 2, pixelPos.y - (pickWindowSize-1) / 2, 
		pickWindowSize, pickWindowSize, 
		renderer.context.RGBA, renderer.context.UNSIGNED_BYTE, pixels);
		
	// find closest hit inside pixelWindow boundaries
	var min = Number.MAX_VALUE;
	var hit = null;
	//console.log("finding closest hit");
	for(var u = 0; u < pickWindowSize; u++){
		for(var v = 0; v < pickWindowSize; v++){
			var offset = (u + v*pickWindowSize);
			var distance = Math.pow(u - (pickWindowSize-1) / 2, 2) + Math.pow(v - (pickWindowSize-1) / 2, 2);
			
			var pcIndex = pixels[4*offset + 3];
			pixels[4*offset + 3] = 0;
			var pIndex = ibuffer[offset];
			
			if((pIndex !== 0 || pcIndex !== 0) && distance < min){
				
				hit = {
					pIndex: pIndex,
					pcIndex: pcIndex
				};
				min = distance;
			}
		}
	}	
	
	if(hit){
		var point = {};
		
		var pc = nodes[hit.pcIndex];
		var attributes = pc.geometry.attributes;
		
		for (var property in attributes) {
			if (attributes.hasOwnProperty(property)) {
				var values = geometry.attributes[property];
			
				if(property === "position"){
					var positionArray = pc.geometry.attributes.position.array;
					var x = positionArray[3*hit.pIndex+0];
					var y = positionArray[3*hit.pIndex+1];
					var z = positionArray[3*hit.pIndex+2];
					var position = new THREE.Vector3(x, y, z);
					position.applyMatrix4(this.matrixWorld);
				
					point[property] = position;
				}else if(property === "indices"){
				
				}else{
					if(values.itemSize === 1){
						point[property] = values.array[i + j];
					}else{
						var value = [];
						for(var j = 0; j < values.itemSize; j++){
							value.push(values.array[i*values.itemSize + j]);
						}
						point[property] = value;
					}
				}
			}
		}
		
		
		return point;
	}else{
		return null;
	}
}

var demTime = 0;

Potree.PointCloudOctree.prototype.createDEM = function(node){
	
	var start = new Date().getTime();


	var world = node.matrixWorld;

	var boundingBox = node.boundingBox.clone().applyMatrix4(world);
	var bbSize = boundingBox.size();
	var positions = node.geometry.attributes.position.array;
	var demSize = 64;
	var demMArray = new Array(demSize*demSize);
	var dem = new Float32Array(demSize*demSize);
	var n = positions.length / 3;
	
	var toWorld = function(dx, dy){
		var x = (dx * bbSize.x) / (demSize - 1) + boundingBox.min.x;
		var y = dem[dx + dy * demSize];
		var z = (dy * bbSize.z) / (demSize - 1)+ boundingBox.min.z;
		
		return [x, y, z];
	};
	
	var toDem = function(x, y){
		var dx = parseInt(demSize * (x - boundingBox.min.x) / bbSize.x);
		var dy = parseInt(demSize * (z - boundingBox.min.z) / bbSize.z);
		dx = Math.min(dx, demSize - 1);
		dy = Math.min(dy, demSize - 1);
		
		return [dx, dy];
	};

	for(var i = 0; i < n; i++){
		var x = positions[3*i + 0];
		var y = positions[3*i + 1];
		var z = positions[3*i + 2];
		
		var worldPos = new THREE.Vector3(x,y,z).applyMatrix4(world);
		
		var dx = parseInt(demSize * (worldPos.x - boundingBox.min.x) / bbSize.x);
		var dy = parseInt(demSize * (worldPos.z - boundingBox.min.z) / bbSize.z);
		dx = Math.min(dx, demSize - 1);
		dy = Math.min(dy, demSize - 1);
		
		var index = dx + dy * demSize;
		if(!demMArray[index]){
			demMArray[index] = [];
		}
		demMArray[index].push(worldPos.y);
		
		//if(dem[dx + dy * demSize] === 0){
		//	dem[dx + dy * demSize] = worldPos.y;
		//}else{
		//	dem[dx + dy * demSize] = Math.max(dem[dx + dy * demSize], worldPos.y);
		//}
	}
	
	for(var i = 0; i < demMArray.length; i++){
		var values = demMArray[i];
		
		if(!values){
			dem[i] = 0;
		}else if(values.length === 0){
			dem[i] = 0;
		}else{
			var medianIndex = parseInt((values.length-1) / 2); 
			dem[i] = values[medianIndex];
		}
	}
	
	var box2 = new THREE.Box2();
	box2.expandByPoint(new THREE.Vector3(boundingBox.min.x, boundingBox.min.z));
	box2.expandByPoint(new THREE.Vector3(boundingBox.max.x, boundingBox.max.z));
	
	var result = {
		boundingBox: boundingBox,
		boundingBox2D: box2,
		dem: dem,
		demSize: demSize
	};
	
	
	
	//var geometry = new THREE.BufferGeometry();
	//var vertices = new Float32Array((demSize-1)*(demSize-1)*2*3*3);
	//var offset = 0;
	//for(var i = 0; i < demSize-1; i++){
	//	for(var j = 0; j < demSize-1; j++){
	//		//var offset = 18*i + 18*j*demSize;
	//		
	//		var dx = i;
	//		var dy = j;
	//		
	//		var v1 = toWorld(dx, dy);
	//		var v2 = toWorld(dx+1, dy);
	//		var v3 = toWorld(dx+1, dy+1);
	//		var v4 = toWorld(dx, dy+1);
	//		
	//		vertices[offset+0] = v3[0];
	//		vertices[offset+1] = v3[1];
	//		vertices[offset+2] = v3[2];
	//		
	//		vertices[offset+3] = v2[0];
	//		vertices[offset+4] = v2[1];
	//		vertices[offset+5] = v2[2];
	//		
	//		vertices[offset+6] = v1[0];
	//		vertices[offset+7] = v1[1];
	//		vertices[offset+8] = v1[2];
	//		
	//		
	//		vertices[offset+9 ] = v3[0];
	//		vertices[offset+10] = v3[1];
	//		vertices[offset+11] = v3[2];
	//		
	//		vertices[offset+12] = v1[0];
	//		vertices[offset+13] = v1[1];
	//		vertices[offset+14] = v1[2];
	//		
	//		vertices[offset+15] = v4[0];
	//		vertices[offset+16] = v4[1];
	//		vertices[offset+17] = v4[2];
	//		         
	//		        
	//		
	//		//var x = (dx * bbSize.min.x) / demSize + boundingBox.min.x;
	//		//var y = (dy * bbSize.min.y) / demSize + boundingBox.min.y;
	//		//var z = dem[dx + dy * demSize];
	//		
	//		offset += 18;
	//		
	//	}
	//}
	//
	//geometry.addAttribute( 'position', new THREE.BufferAttribute( vertices, 3 ) );
	//geometry.computeFaceNormals();
	//geometry.computeVertexNormals();
	//
	//var material = new THREE.MeshNormalMaterial( { color: 0xff0000, shading: THREE.SmoothShading } );
	//var mesh = new THREE.Mesh( geometry, material );
	//
	//if(node.level == 1){
	//	scene.add(mesh);
	//	
	//	var demb = new Uint8Array(demSize*demSize*4);
	//	for(var i = 0; i < demSize*demSize; i++){
	//		demb[4*i + 0] = 255 * dem[i] / 6000;
	//		demb[4*i + 1] = 255 * dem[i] / 6000;
	//		demb[4*i + 2] = 255 * dem[i] / 6000;
	//		demb[4*i + 3] = 255;
	//	}
	//
	//	var img = pixelsArrayToImage(demb, demSize, demSize);
	//	img.style.boder = "2px solid red";
	//	var txt = document.createElement("div");
	//	txt.innerHTML = node.name;
	//	document.body.appendChild(txt);
	//	document.body.appendChild(img);
	//}


	
	//console.log(n);
    //
	var end = new Date().getTime();
	var duration = end - start;
	//console.log(node.numPoints + " - " + duration);
	
	demTime += duration;
	
	
	

	return result;
}

Potree.PointCloudOctree.prototype.getDEMHeight = function(position){
	var pos2 = new THREE.Vector2(position.x, position.z);
	
	var demHeight = function(dem){
		var demSize = dem.demSize;
		var box = dem.boundingBox2D;
		var insideBox = box.containsPoint(pos2);
		if(box.containsPoint(pos2)){
			var uv = pos2.clone().sub(box.min).divide(box.size());
			var xy = uv.clone().multiplyScalar(demSize);
			
			var demHeight = 0;
			
			if((xy.x > 0.5 && xy.x < demSize - 0.5) && (xy.y > 0.5 && xy.y < demSize - 0.5)){
				var i = Math.floor(xy.x - 0.5);
				var j = Math.floor(xy.y - 0.5);
				i = (i === demSize - 1) ? (demSize-2) : i;
				j = (j === demSize - 1) ? (demSize-2) : j;
				
				var u = xy.x - i - 0.5;
				var v = xy.y - j - 0.5; 
				
				var index00 = i + j * demSize;
				var index10 = (i+1) + j * demSize;
				var index01 = i + (j+1) * demSize;
				var index11 = (i+1) + (j+1) * demSize;
				
				var height00 = dem.dem[index00];
				var height10 = dem.dem[index10];
				var height01 = dem.dem[index01];
				var height11 = dem.dem[index11];
				
				if(height00 === 0 || height10 === 0 || height01 === 0 || height11 === 0){
					demHeight = null;
				}else{
				
					var hx1 = height00 * (1-u) + height10 * u;
					var hx2 = height01 * (1-u) + height11 * u;
					
					demHeight = hx1 * (1-v) + hx2 * v;
				}
				
				var bla;
			}else{
				xy.x = Math.min(parseInt(Math.min(xy.x, demSize)), demSize-1);
				xy.y = Math.min(parseInt(Math.min(xy.y, demSize)), demSize-1);
			
				var index = xy.x + xy.y * demSize;
				demHeight = dem.dem[index];
			}
			
			
			return demHeight;
		}
		
		return null;
	};
	
	var height = null;
	
	var stack = [];
	var chosenNode = null;
	if(this.children[0].dem){
		stack.push(this.children[0]);
	}
	while(stack.length > 0){
		var node = stack.shift();
		var dem = node.dem;
		
		var demSize = dem.demSize;
		var box = dem.boundingBox2D;
		var insideBox = box.containsPoint(pos2);
		if(!box.containsPoint(pos2)){
			continue;
		}
		
		var dh = demHeight(dem);
		if(!height){
			height = dh;
		}else if(dh != null && dh > 0){
			height = dh;
		}

		if(node.level <= 2){
		for(var i = 0; i < node.children.length; i++){
			var child = node.children[i];
			if(child.dem){
				stack.push(child);
			}
		}
		}
	}
	
	
	
	return height;
}

Potree.PointCloudOctree.prototype.generateTerain = function(){
	var bb = this.boundingBox.clone().applyMatrix4(this.matrixWorld);
	
	var width = 300;
	var height = 300;
	var geometry = new THREE.BufferGeometry();
	var vertices = new Float32Array(width*height*3);
	
	var offset = 0;
	for(var i = 0; i < width; i++){
		for( var j = 0; j < height; j++){
			var u = i / width;
			var v = j / height;
			
			var x = u * bb.size().x + bb.min.x;
			var z = v * bb.size().z + bb.min.z;
			
			var y = this.getDEMHeight(new THREE.Vector3(x, 0, z));
			if(!y){
				y = 0;
			}
			
			vertices[offset + 0] = x;
			vertices[offset + 1] = y;
			vertices[offset + 2] = z;
			
			//var sm = new THREE.Mesh(sg);
			//sm.position.set(x,y,z);
			//scene.add(sm);
			
			offset += 3;
		}
	}
	
	geometry.addAttribute( 'position', new THREE.BufferAttribute( vertices, 3 ) );
	var material = new THREE.PointCloudMaterial({size: 20, color: 0x00ff00});
	
	var pc = new THREE.PointCloud(geometry, material);
	scene.add(pc);
	
};

Object.defineProperty(Potree.PointCloudOctree.prototype, "progress", {
	get: function(){
		return this.visibleNodes.length / this.visibleGeometry.length;
	}
});